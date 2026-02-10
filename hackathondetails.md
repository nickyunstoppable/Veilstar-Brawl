ZK Gaming on Stellar
This hackathon is about exploring Zero-Knowledge (ZK) as a real gameplay primitive — not just a buzzword. Your mission is to build a game prototype that uses ZK for something that actually matters to players: hidden information, fair resolution, provable outcomes, private actions, verifiable computation, or any mechanic where “trust me” isn’t good enough.

And don’t overthink the scope of the game. It doesn’t need to be an MMO or a full commercial title — a clean, minimal prototype like tic-tac-toe, Sudoku, Battleship, or a simple card/strategy game is totally valid as long as ZK is essential to how it works (not just mentioned in a README).

We’re doing this now because Stellar has taken a big step forward for ZK developers with Protocol 25 (X-Ray), which adds protocol-level cryptographic building blocks like BN254 elliptic-curve operations and Poseidon/Poseidon2 hash functions — the kind of primitives modern ZK systems rely on. That means it’s now realistic to build games that can verify ZK proofs on-chain (using toolchains like Noir and zkVM approaches like RISC Zero) and bring new “fair by design” mechanics to Stellar.

2 Minute Hackathon Primer
Watch this short 2 minute video from James Bachini to quickly get up to speed on the hackathon.



Stellar Game Studio - Your Dev Shortcut
Stellar Game Studio simplifies building onchain games and streamlines the Stellar game lifecycle. It’s designed to be a fast starting point for shipping playable web games with onchain components — providing convention over configuration so you can focus on gameplay.

Stellar Game Studio reduces boilerplate by pairing smart contracts with a modern frontend workflow, and includes scripts that help you move from idea → deployed prototype quickly.

Your integration with Stellar Game Studio is required for the hackathon and simplifies many things for you, including two-player game simulation.

Stellar Game Studio: https://jamesbachini.github.io/Stellar-Game-Studio/

GitHub Repository: https://github.com/jamesbachini/Stellar-Game-Studio

Resources
We have a lot of resources to help you during this hackathon. Visit the Resources tab.

VIEW THE QUICKSTART GUIDE TAB FOR DETAILED SETUP INSTRUCTIONS

Submission Guidelines
1) Fork the Game Studio
Fork the game studio from: https://github.com/jamesbachini/Stellar-Game-Studio

Install game-studio:

bun run setup

Create your game using the instructions: https://jamesbachini.github.io/Stellar-Game-Studio/

2) A ZK-Powered Mechanic
Your project must use ZK in a meaningful way. The ZK proof should power a core mechanic, not just appear in a demo slide.

3) A Deployed Onchain Component
Submissions require an onchain component deployed on Stellar Testnet (contracts and any onchain state that your game relies on). Your game contracts must call start_game() and end_game() in the game hub contract: CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG

4) A Front End
A functional user interface is required. Judges should be able to see gameplay and understand how the ZK mechanic and onchain component connect to the player experience.

5) Open-source Repo
A public GitHub/GitLab repository link containing the full source code and a clear README.md.

6) Video Demo
A 2-3 minute video demonstration showing the gameplay and explaining the ZK implementation to assist judges in understanding your submission.

Inspiration & Ideas
Need a spark? Here are a few ZK-native directions that make games more fair, more private, or more interesting:

Hidden-information games: Players commit privately (moves, cards, loadouts) and prove validity without revealing everything.
Provable outcomes: Resolve a match with verifiable computation so players can audit results.
Private actions / fog-of-war: Keep state hidden while still proving that each step is valid.
Provable randomness: Prove fairness without leaking seeds or relying on a trusted server.
Puzzle / strategy proofs: Prove a solution is valid without revealing the solution itself.
$10,000 Prize Pool
This hackathon features a single open innovation track with awards for the top projects:

First Place: $5,000 in XLM
Second Place: $2,000 in XLM
Third Place: $1,250 in XLM
Fourth Place: $1,000 in XLM
Fifth Place: $750 in XLM
Key Dates
Submissions Open: Feb 9, 2026
Submission deadline: Feb 23, 2026
Hackathon Support
The team is here to help you every step of the way. Feel free to drop in any of the following channels for assistance:

Stellar Dev Discord #zk-chat
Stellar Hacks Telegram Group
Note: Please beware of scams via DM on both platforms.