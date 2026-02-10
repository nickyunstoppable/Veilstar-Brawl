# Character Assets

This folder contains placeholder assets for KaspaClash characters.

## Expected Files per Character

Each character folder should contain:

```
{character-id}/
├── portrait.png       # 256x256 character portrait for selection screen
├── idle.png           # Idle animation spritesheet (4 frames)
├── punch.png          # Punch attack spritesheet (6 frames)
├── kick.png           # Kick attack spritesheet (6 frames)
├── block.png          # Block animation spritesheet (3 frames)
├── special.png        # Special attack spritesheet (8 frames)
├── hurt.png           # Taking damage spritesheet (4 frames)
├── victory.png        # Victory pose spritesheet (6 frames)
└── defeat.png         # Defeat pose spritesheet (4 frames)
```

## Spritesheet Specifications

- **Format**: PNG with transparency
- **Frame Size**: 128x128 pixels per frame
- **Layout**: Horizontal strip (frames side by side)
- **Style**: Stylized/anime-inspired, cyberpunk aesthetic

## Characters

1. **Cyber Ninja** (`cyber-ninja/`) - Purple theme, fast and technical
2. **DAG Warrior** (`dag-warrior/`) - Blue theme, balanced fighter
3. **Block Bruiser** (`block-bruiser/`) - Orange theme, heavy hitter
4. **Hash Hunter** (`hash-hunter/`) - Red theme, aggressive attacker

## Current Status

Currently using placeholder SVG portraits. Full sprite sheets will be added as the game develops.
