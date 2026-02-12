/**
 * TransactionToast - Toast notification for transaction confirmations
 * Shows transaction ID with a link to the Kaspa explorer
 */

import Phaser from "phaser";

const NETWORK_CONFIG = {
  mainnet: { explorerUrl: "https://stellar.expert/explorer/public" },
  testnet: { explorerUrl: "https://stellar.expert/explorer/testnet" },
} as const;

/**
 * Determine the network type from an address
 */
function getNetworkFromAddress(address: string): "mainnet" | "testnet" {
  return address.startsWith("T") ? "testnet" : "mainnet";
}

/**
 * Get the explorer URL for a transaction
 */
function getExplorerUrl(txId: string, address: string): string {
  const network = getNetworkFromAddress(address);
  const baseUrl = NETWORK_CONFIG[network].explorerUrl;
  return `${baseUrl}/txs/${txId}`;
}

/**
 * TransactionToast configuration
 */
interface TransactionToastConfig {
  scene: Phaser.Scene;
  x: number;
  y: number;
  txId: string;
  playerAddress: string;
  duration?: number; // Duration in ms, default 3000
  onClose?: () => void;
}

/**
 * TransactionToast class - Phaser container for transaction confirmation notifications
 */
export class TransactionToast extends Phaser.GameObjects.Container {
  private config: TransactionToastConfig;
  private background!: Phaser.GameObjects.Graphics;
  private titleText!: Phaser.GameObjects.Text;
  private txIdText!: Phaser.GameObjects.Text;
  private linkText!: Phaser.GameObjects.Text;
  private closeButton!: Phaser.GameObjects.Container;
  private autoCloseTimer?: Phaser.Time.TimerEvent;
  
  private readonly TOAST_WIDTH = 320;
  private readonly TOAST_HEIGHT = 90;
  private readonly PADDING = 12;
  private readonly BORDER_RADIUS = 8;

  constructor(config: TransactionToastConfig) {
    super(config.scene, config.x, config.y);
    this.config = { duration: 3000, ...config };

    this.createBackground();
    this.createContent();
    this.createCloseButton();
    this.setupAutoClose();
    this.animateIn();

    config.scene.add.existing(this);
    this.setDepth(3000); // Very high depth to be above everything
  }

  /**
   * Create the toast background with gradient and border
   */
  private createBackground(): void {
    this.background = this.scene.add.graphics();
    
    // Main background with dark theme
    this.background.fillStyle(0x0f172a, 0.95);
    this.background.fillRoundedRect(
      -this.TOAST_WIDTH / 2,
      -this.TOAST_HEIGHT / 2,
      this.TOAST_WIDTH,
      this.TOAST_HEIGHT,
      this.BORDER_RADIUS
    );
    
    // Border with accent color (teal/cyan to match Kaspa theme)
    this.background.lineStyle(2, 0x40e0d0, 1);
    this.background.strokeRoundedRect(
      -this.TOAST_WIDTH / 2,
      -this.TOAST_HEIGHT / 2,
      this.TOAST_WIDTH,
      this.TOAST_HEIGHT,
      this.BORDER_RADIUS
    );

    // Success indicator bar on the left
    this.background.fillStyle(0x22c55e, 1);
    this.background.fillRoundedRect(
      -this.TOAST_WIDTH / 2,
      -this.TOAST_HEIGHT / 2,
      4,
      this.TOAST_HEIGHT,
      { tl: this.BORDER_RADIUS, bl: this.BORDER_RADIUS, tr: 0, br: 0 }
    );

    this.add(this.background);
  }

  /**
   * Create the toast content (title, transaction ID, and link)
   */
  private createContent(): void {
    const contentX = -this.TOAST_WIDTH / 2 + this.PADDING + 8; // Extra offset for success bar
    const contentWidth = this.TOAST_WIDTH - this.PADDING * 2 - 40; // Leave room for close button

    // Title with checkmark
    this.titleText = this.scene.add.text(
      contentX,
      -this.TOAST_HEIGHT / 2 + this.PADDING,
      "✓ Transaction Confirmed",
      {
        fontFamily: "Orbitron, Arial",
        fontSize: "14px",
        color: "#22c55e",
        fontStyle: "bold",
      }
    );
    this.add(this.titleText);

    // Transaction ID (truncated)
    const truncatedTxId = this.truncateTxId(this.config.txId);
    this.txIdText = this.scene.add.text(
      contentX,
      -this.TOAST_HEIGHT / 2 + this.PADDING + 22,
      `TX: ${truncatedTxId}`,
      {
        fontFamily: "Courier New, monospace",
        fontSize: "11px",
        color: "#94a3b8",
      }
    );
    this.add(this.txIdText);

    // View on Explorer link
    this.linkText = this.scene.add.text(
      contentX,
      -this.TOAST_HEIGHT / 2 + this.PADDING + 44,
      "🔗 View on Explorer",
      {
        fontFamily: "Orbitron, Arial",
        fontSize: "12px",
        color: "#40e0d0",
      }
    );
    this.linkText.setInteractive({ useHandCursor: true });
    
    // Hover effects
    this.linkText.on("pointerover", () => {
      this.linkText.setColor("#5ef6e6");
      this.linkText.setStyle({ textDecoration: "underline" });
    });
    this.linkText.on("pointerout", () => {
      this.linkText.setColor("#40e0d0");
    });
    
    // Click to open explorer
    this.linkText.on("pointerdown", () => {
      const url = getExplorerUrl(this.config.txId, this.config.playerAddress);
      window.open(url, "_blank", "noopener,noreferrer");
    });

    this.add(this.linkText);
  }

  /**
   * Create the close button
   */
  private createCloseButton(): void {
    this.closeButton = this.scene.add.container(
      this.TOAST_WIDTH / 2 - this.PADDING - 8,
      -this.TOAST_HEIGHT / 2 + this.PADDING + 8
    );

    // Close button background circle
    const closeBg = this.scene.add.graphics();
    closeBg.fillStyle(0x334155, 1);
    closeBg.fillCircle(0, 0, 12);
    this.closeButton.add(closeBg);

    // X icon
    const closeX = this.scene.add.text(0, 0, "✕", {
      fontFamily: "Arial",
      fontSize: "14px",
      color: "#94a3b8",
    });
    closeX.setOrigin(0.5, 0.5);
    this.closeButton.add(closeX);

    // Make interactive
    this.closeButton.setSize(24, 24);
    this.closeButton.setInteractive({ useHandCursor: true });

    // Hover effects
    this.closeButton.on("pointerover", () => {
      closeBg.clear();
      closeBg.fillStyle(0x475569, 1);
      closeBg.fillCircle(0, 0, 12);
      closeX.setColor("#ffffff");
    });
    this.closeButton.on("pointerout", () => {
      closeBg.clear();
      closeBg.fillStyle(0x334155, 1);
      closeBg.fillCircle(0, 0, 12);
      closeX.setColor("#94a3b8");
    });

    // Close on click
    this.closeButton.on("pointerdown", () => {
      this.close();
    });

    this.add(this.closeButton);
  }

  /**
   * Setup auto-close timer
   */
  private setupAutoClose(): void {
    this.autoCloseTimer = this.scene.time.delayedCall(
      this.config.duration!,
      () => {
        this.close();
      }
    );
  }

  /**
   * Animate the toast sliding in
   */
  private animateIn(): void {
    // Start from right side off-screen
    this.setAlpha(0);
    this.setX(this.config.x + 100);

    this.scene.tweens.add({
      targets: this,
      x: this.config.x,
      alpha: 1,
      duration: 250,
      ease: "Back.easeOut",
    });
  }

  /**
   * Close the toast with animation
   */
  public close(): void {
    // Cancel auto-close timer if still pending
    if (this.autoCloseTimer) {
      this.autoCloseTimer.destroy();
      this.autoCloseTimer = undefined;
    }

    // Animate out
    this.scene.tweens.add({
      targets: this,
      x: this.config.x + 100,
      alpha: 0,
      duration: 200,
      ease: "Power2",
      onComplete: () => {
        this.config.onClose?.();
        this.destroy();
      },
    });
  }

  /**
   * Truncate transaction ID for display
   */
  private truncateTxId(txId: string): string {
    if (txId.length <= 20) return txId;
    return `${txId.slice(0, 10)}...${txId.slice(-8)}`;
  }
}

export default TransactionToast;
