const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

console.log("Starting server...");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const frontendPath = process.env.FRONTEND_PATH || path.join(__dirname, "public");
const frontendEntry = path.join(frontendPath, "index.html");

if (!fs.existsSync(frontendEntry)) {
    throw new Error(`Frontend entry point not found: ${frontendEntry}`);
}

app.use(express.static(frontendPath));

console.log("Server configuration complete, waiting to listen...");

// Store information about each room
const rooms = {};

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // User joins a room
    socket.on("join-room", ({ roomId, role, name }) => {

        socket.join(roomId);

        // Create room if it doesn't exist
        if (!rooms[roomId]) {
            rooms[roomId] = {
                tutor: null,
                students: [],
                whiteboardLocked: false,
                currentLesson: null,
                quizRound: 0
            };
        }

        const room = rooms[roomId];

        // Save user's role
        socket.roomId = roomId;
        socket.role = role;
        socket.displayName = name || "Guest";

        if (role === "tutor") {
            rooms[roomId].tutor = socket.id;
        } else {
            rooms[roomId].students.push(socket.id);
        }

        console.log(`${role} joined room ${roomId}`);

        // Send current whiteboard lock status
        socket.emit("whiteboard-lock-status", {
            locked: rooms[roomId].whiteboardLocked
        });

        socket.emit("room-users", {
            users: [
                ...(room.tutor && room.tutor !== socket.id ? [room.tutor] : []),
                ...room.students.filter(id => id !== socket.id)
            ],
            names: Object.fromEntries(
                [
                    ...(room.tutor && room.tutor !== socket.id ? [room.tutor] : []),
                    ...room.students.filter(id => id !== socket.id)
                ].map(id => [id, io.sockets.sockets.get(id)?.displayName || "Partner"])
            )
        });

        if (room.currentLesson) {
            socket.emit("lesson-selected", { lesson: room.currentLesson });
        }

        if (room.quizRound > 0) {
            socket.emit("quiz-sync", {
                lesson: room.currentLesson,
                round: room.quizRound
            });
        }

        // Tell other users someone joined
        socket.to(roomId).emit("user-joined", {
            socketId: socket.id,
            role: role,
            name: socket.displayName
        });
    });


    // =========================
    // WHITEBOARD DRAWING
    // =========================

    socket.on("whiteboard-draw", (data) => {

        const room = rooms[socket.roomId];

        if (!room) return;

        // Student cannot draw if tutor locked the board
        if (
            socket.role !== "tutor" &&
            room.whiteboardLocked
        ) {
            socket.emit("drawing-rejected", {
                message: "The tutor has locked the whiteboard."
            });

            return;
        }

        // Send drawing to everyone else in the room
        socket.to(socket.roomId).emit(
            "whiteboard-draw",
            data
        );
    });


    // =========================
    // ERASE
    // =========================

    socket.on("whiteboard-erase", (data) => {

        const room = rooms[socket.roomId];

        if (!room) return;

        if (
            socket.role !== "tutor" &&
            room.whiteboardLocked
        ) {
            return;
        }

        socket.to(socket.roomId).emit(
            "whiteboard-erase",
            data
        );
    });


    // =========================
    // CLEAR WHITEBOARD
    // =========================

    socket.on("whiteboard-clear", (data = {}) => {

        const room = rooms[socket.roomId];

        if (!room) return;

        if (
            socket.role !== "tutor" &&
            room.whiteboardLocked
        ) {
            return;
        }

        io.to(socket.roomId).emit("whiteboard-clear", data);
    });

    socket.on("whiteboard-delete", (data = {}) => {
        const room = rooms[socket.roomId];
        if (!room) return;
        if (socket.role !== "tutor" && room.whiteboardLocked) return;
        socket.to(socket.roomId).emit("whiteboard-draw", {
            type: "delete",
            boardId: data.boardId,
            id: data.id
        });
    });


    // =========================
    // TUTOR LOCKS WHITEBOARD
    // =========================

    socket.on("lock-whiteboard", () => {

        const room = rooms[socket.roomId];

        if (!room) return;

        // Only tutor can lock the board
        if (socket.role !== "tutor") {
            return;
        }

        room.whiteboardLocked = true;

        io.to(socket.roomId).emit(
            "whiteboard-lock-status",
            {
                locked: true
            }
        );

        console.log(
            `Whiteboard locked in room ${socket.roomId}`
        );
    });


    // =========================
    // TUTOR UNLOCKS WHITEBOARD
    // =========================

    socket.on("unlock-whiteboard", () => {

        const room = rooms[socket.roomId];

        if (!room) return;

        // Only tutor can unlock the board
        if (socket.role !== "tutor") {
            return;
        }

        room.whiteboardLocked = false;

        io.to(socket.roomId).emit(
            "whiteboard-lock-status",
            {
                locked: false
            }
        );

        console.log(
            `Whiteboard unlocked in room ${socket.roomId}`
        );
    });


    // =========================
    // WEBRTC SIGNALING
    // =========================

    socket.on("offer", (data) => {
        socket.to(data.roomId).emit("offer", {
            offer: data.offer,
            sender: socket.id
        });
    });

    socket.on("answer", (data) => {
        socket.to(data.roomId).emit("answer", {
            answer: data.answer,
            sender: socket.id
        });
    });

    socket.on("ice-candidate", (data) => {
        socket.to(data.roomId).emit("ice-candidate", {
            candidate: data.candidate,
            sender: socket.id
        });
    });

    socket.on("quiz-answer", (data) => {
        socket.to(data.roomId).emit("quiz-answer", {
            question: data.question,
            answer: data.answer,
            correct: data.correct
        });
    });

    socket.on("end-call", ({ roomId }) => {
        if (!roomId || roomId !== socket.roomId) return;
        socket.to(roomId).emit("call-ended");
    });

    socket.on("lesson-given-changed", ({ roomId, lesson, index }) => {
        if (!roomId || roomId !== socket.roomId || !lesson || !Number.isInteger(index)) return;
        socket.to(roomId).emit("lesson-given-changed", { lesson, index });
    });

    socket.on("lesson-selected", ({ roomId, lesson }) => {
        if (!roomId || !lesson) return;

        const room = rooms[roomId];
        if (!room) return;

        room.currentLesson = lesson;
        io.to(roomId).emit("lesson-selected", {
            lesson,
            selectedBy: socket.id
        });
    });

    socket.on("quiz-start", ({ roomId, lesson }) => {
        if (!roomId || !lesson) return;

        const room = rooms[roomId];
        if (!room) return;

        room.currentLesson = lesson;
        room.quizRound += 1;

        io.to(roomId).emit("quiz-sync", {
            lesson,
            round: room.quizRound,
            startedBy: socket.id
        });
    });


    // =========================
    // USER DISCONNECTS
    // =========================

    socket.on("disconnect", () => {

        console.log("User disconnected:", socket.id);

        const roomId = socket.roomId;

        if (!roomId || !rooms[roomId]) {
            return;
        }

        const room = rooms[roomId];

        if (room.tutor === socket.id) {
            room.tutor = null;
        }

        room.students = room.students.filter(
            id => id !== socket.id
        );

        socket.to(roomId).emit("user-left", {
            socketId: socket.id
        });

        // Delete empty room
        if (
            room.tutor === null &&
            room.students.length === 0
        ) {
            delete rooms[roomId];
        }
    });
});


// Basic server response
app.get("/", (req, res) => {
    res.sendFile(frontendEntry);
});

app.get("/healthz", (req, res) => {
    res.sendStatus(200);
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on port ${PORT}`);
});