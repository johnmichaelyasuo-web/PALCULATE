# Deploying Palculate

The backend serves the frontend and Socket.IO from one web service. This keeps
the app and its real-time signaling on the same origin.

## Deploy with Render

1. Make sure the latest frontend is copied to `public/index.html`.
2. Put this backend folder (including `public/index.html`, `package.json`,
   `package-lock.json`, `server.js`, and `render.yaml`) in a Git repository and
   push it to GitHub. Do not include `node_modules`.
3. In Render, create a new **Blueprint** and select that GitHub repository.
   Render reads `render.yaml`, installs dependencies, and starts the service.
4. Once deployment is complete, open the HTTPS URL Render provides and share
   it with other users.

The server listens on the `PORT` supplied by the hosting provider and serves
the built-in `public` directory. To serve a different frontend directory, set
`FRONTEND_PATH` to its path in the hosting environment.

## Video-call networking

The app requests camera and microphone access, which browsers require to be
served over HTTPS (or from localhost). The app currently uses a public STUN
server for peer-to-peer WebRTC; users on some restrictive networks may also
need a TURN service for reliable video connections.
