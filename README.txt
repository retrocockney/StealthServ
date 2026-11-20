STEALTH SECTOR 04 - ONLINE STARTER

FILES
- index.html: the game. Upload this to your GitHub Pages repository as index.html.
- server.js: the Render multiplayer server.
- package.json: Node project settings and the WebSocket dependency.
- .gitignore: keeps node_modules and local files out of Git.

RENDER SETUP
1. Put all four files in the same GitHub repository (or put the server files in the repository root).
2. In Render, create a new Web Service and connect that repository.
3. Runtime: Node.
4. Build Command: npm install
5. Start Command: npm start
6. Deploy. Render will give you a service address ending in onrender.com.

GITHUB PAGES
Keep index.html in the GitHub Pages publishing folder. The game itself stays on GitHub Pages. Render runs only server.js.

IN GAME
Open the game, choose ONLINE MULTIPLAYER, paste the Render address into the server box, then choose 1v1 or FFA. The game changes https:// to wss:// automatically. For local testing use ws://localhost:10000.

MATCH RULES
- 1v1: two players, first to 10 kills.
- FFA: up to 8 players, first to 10 kills.
- Eliminated players respawn after 2.5 seconds.

NOTE
This is the first online integration pass. Test with two browser windows after deploying. Keep the existing single-player start option for the original game. The Render server needs to be running for online matchmaking.
