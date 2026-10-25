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
const MAX_REQUEST_BODY = "16kb";

if (!fs.existsSync(frontendEntry)) {
    throw new Error(`Frontend entry point not found: ${frontendEntry}`);
}

app.use(express.json({ limit: MAX_REQUEST_BODY }));
app.use(express.static(frontendPath));

console.log("Server configuration complete, waiting to listen...");

class ApiError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

function supabaseConfig(requireAnonKey = false) {
    const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || (requireAnonKey && !SUPABASE_ANON_KEY)) {
        throw new ApiError(503, "Account features are not configured yet. Please try again later.");
    }
    return {
        url: SUPABASE_URL.replace(/\/+$/, ""),
        anonKey: SUPABASE_ANON_KEY,
        serviceKey: SUPABASE_SERVICE_ROLE_KEY
    };
}

async function supabaseRequest(pathname, { method = "GET", body, apiKey, accessToken, prefer } = {}) {
    const config = supabaseConfig();
    const headers = {
        apikey: apiKey || config.serviceKey,
        Authorization: `Bearer ${accessToken || config.serviceKey}`
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;

    const response = await fetch(`${config.url}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const responseText = await response.text();
    let data = null;
    if (responseText) {
        try {
            data = JSON.parse(responseText);
        } catch {
            data = { message: responseText };
        }
    }

    if (!response.ok) {
        const message = data?.msg || data?.message || data?.error_description || data?.error || "Supabase request failed.";
        throw new ApiError(response.status >= 400 && response.status < 500 ? response.status : 502, message);
    }
    return data;
}

function apiRoute(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            console.error("API request failed:", error);
            const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
            res.status(statusCode).json({
                error: statusCode === 500 ? "An unexpected server error occurred." : error.message
            });
        }
    };
}

async function authenticatedUser(req) {
    const authorization = req.get("authorization") || "";
    const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) throw new ApiError(401, "Please log in to continue.");

    const config = supabaseConfig(true);
    const user = await supabaseRequest("/auth/v1/user", {
        apiKey: config.anonKey,
        accessToken
    });
    if (!user?.id) throw new ApiError(401, "Your login session is not valid. Please log in again.");
    return user;
}

async function profileForUser(user) {
    const query = new URLSearchParams({
        select: "id,username,total_xp",
        id: `eq.${user.id}`,
        limit: "1"
    });
    const profiles = await supabaseRequest(`/rest/v1/profiles?${query}`);
    const profile = profiles[0];
    if (!profile) throw new ApiError(500, "Your account profile was not created. Please contact support.");
    return {
        id: profile.id,
        username: profile.username,
        totalXp: profile.total_xp
    };
}

app.post("/api/auth/signup", apiRoute(async (req, res) => {
    const { email, password, username } = req.body || {};
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        throw new ApiError(400, "Enter a valid email address.");
    }
    if (typeof password !== "string" || password.length < 8) {
        throw new ApiError(400, "Password must be at least 8 characters.");
    }
    if (typeof username !== "string" || !/^[A-Za-z0-9_. -]{2,24}$/.test(username.trim())) {
        throw new ApiError(400, "Username must be 2–24 characters and use letters, numbers, spaces, dots, dashes, or underscores.");
    }

    const config = supabaseConfig(true);
    const result = await supabaseRequest("/auth/v1/signup", {
        method: "POST",
        apiKey: config.anonKey,
        accessToken: config.anonKey,
        body: {
            email: email.trim().toLowerCase(),
            password,
            data: { display_name: username.trim() }
        }
    });
    res.status(201).json({
        accessToken: result.access_token || null,
        refreshToken: result.refresh_token || null,
        user: result.user || null,
        needsEmailConfirmation: !result.access_token
    });
}));

app.post("/api/auth/login", apiRoute(async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
        throw new ApiError(400, "Enter your email and password.");
    }
    const config = supabaseConfig(true);
    const result = await supabaseRequest("/auth/v1/token?grant_type=password", {
        method: "POST",
        apiKey: config.anonKey,
        accessToken: config.anonKey,
        body: { email: email.trim().toLowerCase(), password }
    });
    res.json({
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        user: result.user
    });
}));

app.post("/api/auth/refresh", apiRoute(async (req, res) => {
    const { refreshToken } = req.body || {};
    if (typeof refreshToken !== "string" || !refreshToken) {
        throw new ApiError(400, "Your login session expired. Please log in again.");
    }
    const config = supabaseConfig(true);
    const result = await supabaseRequest("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        apiKey: config.anonKey,
        accessToken: config.anonKey,
        body: { refresh_token: refreshToken }
    });
    res.json({
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        user: result.user
    });
}));

app.get("/api/me", apiRoute(async (req, res) => {
    const user = await authenticatedUser(req);
    res.json(await profileForUser(user));
}));

app.get("/api/leaderboard", apiRoute(async (_req, res) => {
    const query = new URLSearchParams({
        select: "id,username,total_xp",
        order: "total_xp.desc,username.asc",
        limit: "100"
    });
    const profiles = await supabaseRequest(`/rest/v1/profiles?${query}`);
    res.json(profiles.map(profile => ({
        id: profile.id,
        username: profile.username,
        totalXp: profile.total_xp
    })));
}));

app.post("/api/xp-award", apiRoute(async (req, res) => {
    const user = await authenticatedUser(req);
    const { roundId, role, correct, wrong } = req.body || {};
    if (typeof roundId !== "string" || !/^[A-Za-z0-9-]{8,100}$/.test(roundId)) {
        throw new ApiError(400, "This quiz session is not valid. Please try another quiz.");
    }
    if (!["tutor", "tutee"].includes(role)) {
        throw new ApiError(400, "Choose a valid role before earning XP.");
    }
    if (!Number.isInteger(correct) || !Number.isInteger(wrong) ||
        correct < 0 || wrong < 0 || correct + wrong !== 2) {
        throw new ApiError(400, "XP is awarded after all two quiz questions are answered.");
    }

    const tuteeXp = correct * 50 + wrong * 25;
    const amount = role === "tutor" ? Math.round(tuteeXp * 1.5) : tuteeXp;
    const result = await supabaseRequest("/rest/v1/rpc/award_quiz_xp", {
        method: "POST",
        body: {
            p_user_id: user.id,
            p_round_id: roundId,
            p_amount: amount
        }
    });
    const award = result?.[0];
    if (!award || !Number.isInteger(award.total_xp)) {
        throw new ApiError(502, "XP could not be saved. Please try again.");
    }
    res.json({ totalXp: award.total_xp, awarded: award.awarded });
}));

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