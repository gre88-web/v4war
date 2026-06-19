import Phaser from "phaser";
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  formatEther,
  type Eip1193Provider,
  type JsonRpcSigner,
} from "ethers";
import { SIEGE_ABI } from "./abi";
import { checkGeoblock } from "./geoblock";
import "./style.css";

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

const DWARVES = 0;
const ORCS = 1;
const TOTAL_TILES = 10_000;
const FIELD_WIDTH = 125;
const FIELD_HEIGHT = 80;
const HEX_COLS = 52;
const HEX_ROWS = 30;
const SEED = 0xC0FFEE;

const configuredAddress = import.meta.env.VITE_CONTRACT_ADDRESS ?? "";
const hasContract = /^0x[a-fA-F0-9]{40}$/.test(configuredAddress);
const chainId = Number(import.meta.env.VITE_CHAIN_ID ?? 11155111);
const rpcUrl = import.meta.env.VITE_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

const provider = new JsonRpcProvider(rpcUrl, chainId);
let browserProvider: BrowserProvider | undefined;
let signer: JsonRpcSigner | undefined;
let account: string | undefined;
let geoblocked = false;

type GameState = {
  front: number;
  jackpot: bigint;
  bonusPool: bigint;
  deadline: number;
  phase: number;
  winner: number;
};

type UnitActor = {
  side: number;
  row: number;
  columnOffset: number;
  phase: number;
  charge: number;
  container: Phaser.GameObjects.Container;
};

type HexMetrics = {
  size: number;
  width: number;
  height: number;
  xStep: number;
  yStep: number;
  originX: number;
  originY: number;
};

const state: GameState = {
  front: 5_000,
  jackpot: 0n,
  bonusPool: 0n,
  deadline: 0,
  phase: 0,
  winner: 255,
};

let lastJackpot = 0n;
let battleScene: BattleScene | undefined;

const jackpotEl = element("jackpot");
const bonusEl = element("bonus");
const timerEl = element("timer");
const dwarfPctEl = element("dwarfPct");
const orcPctEl = element("orcPct");
const dwarfBarEl = element("dwarfBar");
const orcBarEl = element("orcBar");
const frontMarkerEl = element("frontMarker");
const statusEl = element("status");
const connectButton = element<HTMLButtonElement>("connect");
const pushDwarvesButton = element<HTMLButtonElement>("pushDwarves");
const pushOrcsButton = element<HTMLButtonElement>("pushOrcs");
const claimButton = element<HTMLButtonElement>("claim");
const tilesInput = element<HTMLInputElement>("tiles");
const dwarfPriceEl = element("dwarfPrice");
const orcPriceEl = element("orcPrice");
const victoryEl = element("victory");
const victoryTitleEl = element("victoryTitle");
const victoryTextEl = element("victoryText");

connectButton.addEventListener("click", () => void connectWallet());
pushDwarvesButton.addEventListener("click", () => void push(DWARVES));
pushOrcsButton.addEventListener("click", () => void push(ORCS));
claimButton.addEventListener("click", () => void claim());
tilesInput.addEventListener("input", () => void updatePrices());

async function initialise(): Promise<void> {
  const block = await checkGeoblock();
  geoblocked = block.blocked;

  if (geoblocked) {
    setStatus(block.reason ?? "Access restricted in this region.");
    setActionsDisabled(true);
    return;
  }

  if (!hasContract) {
    setStatus("Set VITE_CONTRACT_ADDRESS to a deployed SiegeOfTheCrown contract.");
    setActionsDisabled(true);
    battleScene?.setGameState(state, state.front);
    return;
  }

  setStatus("Reading battlefield state...");
  await refreshState();
  await updatePrices();
  watchEvents();

  window.setInterval(() => void refreshState(), 4_000);
  window.setInterval(updateHud, 1_000);
}

async function connectWallet(): Promise<void> {
  if (!window.ethereum) {
    setStatus("No injected wallet found.");
    return;
  }

  browserProvider = new BrowserProvider(window.ethereum);
  await browserProvider.send("eth_requestAccounts", []);
  signer = await browserProvider.getSigner();
  account = await signer.getAddress();
  connectButton.textContent = `${account.slice(0, 6)}...${account.slice(-4)}`;
  connectButton.classList.add("connected");
  await updatePrices();
  setStatus("Wallet connected. Pushes use exact quoted contract costs.");
}

async function refreshState(): Promise<void> {
  if (!hasContract) {
    return;
  }

  const [front, jackpot, bonusPool, deadline, phase, winner] = await readContract().gameState();
  const previousFront = state.front;

  state.front = Number(front);
  state.jackpot = jackpot;
  state.bonusPool = bonusPool;
  state.deadline = Number(deadline);
  state.phase = Number(phase);
  state.winner = Number(winner);

  battleScene?.setGameState(state, previousFront);

  if (jackpot > lastJackpot) {
    jackpotEl.classList.add("flash");
    window.setTimeout(() => jackpotEl.classList.remove("flash"), 450);
    const side = state.front >= previousFront ? DWARVES : ORCS;
    battleScene?.playPushEffect(side, `+Ξ${formatEth(jackpot - lastJackpot)}`);
  }
  lastJackpot = jackpot;

  updateHud();
  await updatePrices();
}

async function updatePrices(): Promise<void> {
  if (!hasContract) {
    dwarfPriceEl.textContent = "--";
    orcPriceEl.textContent = "--";
    return;
  }

  const tiles = readTilesInput();
  try {
    const [dwarfCost, orcCost] = await Promise.all([
      readContract().costForTiles(DWARVES, tiles),
      readContract().costForTiles(ORCS, tiles),
    ]);

    dwarfPriceEl.textContent = `Ξ${formatEth(dwarfCost)}`;
    orcPriceEl.textContent = `Ξ${formatEth(orcCost)}`;
    setActionsDisabled(geoblocked || state.phase !== 0);
  } catch {
    dwarfPriceEl.textContent = "keep";
    orcPriceEl.textContent = "keep";
  }
}

async function push(faction: number): Promise<void> {
  if (!signer || !account) {
    await connectWallet();
  }
  if (!signer || !account || !hasContract || geoblocked) {
    return;
  }

  const tiles = readTilesInput();
  const writable = writeContract();
  const cost = await writable.costForTiles(faction, tiles);

  setStatus(`Submitting ${faction === DWARVES ? "Dwarf" : "Orc"} push for Ξ${formatEth(cost)}...`);
  battleScene?.playPushEffect(faction, "WAR CRY");
  const tx = await writable.push(faction, { value: cost });
  await tx.wait();
  setStatus("Push confirmed.");
  await refreshState();
}

async function claim(): Promise<void> {
  if (!signer || !account) {
    await connectWallet();
  }
  if (!signer || !account || !hasContract || geoblocked) {
    return;
  }

  setStatus("Submitting claim...");
  const tx = await writeContract().claim();
  await tx.wait();
  setStatus("Claim confirmed.");
}

function watchEvents(): void {
  const contract = readContract();
  contract.on("Pushed", (...args: unknown[]) => {
    const faction = Number(args[1]);
    const previousFront = state.front;
    const newFront = Number(args[3]);
    const paid = args[4] as bigint | undefined;
    state.front = newFront;
    battleScene?.setGameState(state, previousFront);
    battleScene?.playPushEffect(faction, `+Ξ${formatEth(paid ?? 0n)}`);
    void refreshState();
  });

  contract.on("Resolved", (...args: unknown[]) => {
    const winningFaction = Number(args[0]);
    const bonusAwarded = Boolean(args[2]);
    showVictory(winningFaction, bonusAwarded);
    battleScene?.playVictory(winningFaction);
    void refreshState();
  });
}

function updateHud(): void {
  const dwarfPct = (state.front / TOTAL_TILES) * 100;
  const orcPct = 100 - dwarfPct;
  jackpotEl.textContent = `Ξ${formatEth(state.jackpot)}`;
  bonusEl.textContent = `Ξ${formatEth(state.bonusPool)}`;
  dwarfPctEl.textContent = `${dwarfPct.toFixed(2)}%`;
  orcPctEl.textContent = `${orcPct.toFixed(2)}%`;
  dwarfBarEl.style.width = `${dwarfPct}%`;
  orcBarEl.style.width = `${orcPct}%`;
  frontMarkerEl.style.left = `${dwarfPct}%`;

  const secondsLeft = Math.max(0, state.deadline - Math.floor(Date.now() / 1_000));
  timerEl.textContent = state.phase === 0 ? formatClock(secondsLeft) : "RESOLVED";
  timerEl.classList.toggle("danger", state.phase === 0 && secondsLeft <= 20);
  document.body.classList.toggle("dwarf-supermajority", state.front >= 7_000);
  document.body.classList.toggle("orc-supermajority", state.front <= 3_000);

  if (state.phase === 1) {
    showVictory(state.winner, state.front >= 7_000 || state.front <= 3_000);
  } else {
    victoryEl.classList.add("hidden");
  }
}

function showVictory(winner: number, bonusAwarded: boolean): void {
  const faction = winner === DWARVES ? "DWARVES" : "ORCS";
  victoryTitleEl.textContent = `${faction} VICTORIOUS`;
  victoryTextEl.textContent =
    `split Ξ${formatEth(state.jackpot)} pro-rata` +
    (bonusAwarded ? ` (+Ξ${formatEth(state.bonusPool)} bonus)` : " (bonus rolls over)");
  victoryEl.classList.remove("hidden");
}

class BattleScene extends Phaser.Scene {
  private terrain!: Phaser.GameObjects.Graphics;
  private scenery!: Phaser.GameObjects.Graphics;
  private keeps!: Phaser.GameObjects.Graphics;
  private frontLine!: Phaser.GameObjects.Graphics;
  private atmosphere!: Phaser.GameObjects.Graphics;
  private unitLayer!: Phaser.GameObjects.Container;
  private units: UnitActor[] = [];
  private currentState: GameState = { ...state };
  private renderedFront = state.front;

  constructor() {
    super("BattleScene");
  }

  create(): void {
    battleScene = this;
    this.makeTextures();
    this.terrain = this.add.graphics();
    this.scenery = this.add.graphics();
    this.keeps = this.add.graphics();
    this.frontLine = this.add.graphics();
    this.atmosphere = this.add.graphics();
    this.unitLayer = this.add.container(0, 0);
    this.frontLine.setBlendMode(Phaser.BlendModes.ADD);
    this.atmosphere.setBlendMode(Phaser.BlendModes.ADD);
    this.createUnits();
    this.scale.on(Phaser.Scale.Events.RESIZE, () => this.drawScene(this.time.now));
    this.setGameState(state, state.front);
  }

  update(time: number): void {
    this.drawScene(time);
    this.updateUnits(time);
  }

  setGameState(next: GameState, previousFront: number): void {
    this.currentState = { ...next };
    this.tweens.killTweensOf(this);
    this.tweens.add({
      targets: this,
      renderedFront: next.front,
      duration: Math.min(900, 260 + Math.abs(next.front - previousFront) * 2),
      ease: "Cubic.easeOut",
    });
  }

  playPushEffect(faction: number, text: string): void {
    const { width, height } = this.dimensions();
    const hex = this.hexMetrics(width, height);
    const row = Math.floor(pseudoRandom(this.currentState.front + SEED + this.time.now) * HEX_ROWS);
    const center = this.hexCenter(Math.floor(this.frontColumnForRow(row, this.time.now)), row, hex);
    const x = center.x;
    const y = center.y;
    const color = faction === DWARVES ? 0x0036ff : 0xff0000;
    const sparks = this.add.particles(x, y, "spark", {
      lifespan: { min: 360, max: 920 },
      speed: { min: 80, max: 410 },
      angle: faction === DWARVES ? { min: -35, max: 45 } : { min: 135, max: 215 },
      gravityY: 320,
      scale: { start: 1.35, end: 0 },
      alpha: { start: 0.95, end: 0 },
      tint: [color, 0xffdf5c, 0xffffff],
      quantity: 48,
      blendMode: Phaser.BlendModes.ADD,
    });

    this.time.delayedCall(920, () => sparks.destroy());
    this.cameras.main.shake(260, 0.0065);
    this.flashRing(x, y, color);
    this.floatText(x, y - 28, text, color);

    for (const unit of this.units.filter((actor) => actor.side === faction)) {
      this.tweens.add({
        targets: unit,
        charge: faction === DWARVES ? hex.xStep * 0.65 : -hex.xStep * 0.65,
        duration: 140,
        yoyo: true,
        ease: "Back.easeOut",
      });
    }
  }

  playVictory(winner: number): void {
    const color = winner === DWARVES ? 0x83d6ff : 0xff7048;
    const { width, height } = this.dimensions();
    this.cameras.main.shake(900, 0.012);
    for (let i = 0; i < 9; i += 1) {
      this.time.delayedCall(i * 90, () => {
        this.flashRing(width * (0.16 + i * 0.085), height * (0.22 + pseudoRandom(i) * 0.58), color);
      });
    }
  }

  private drawScene(time: number): void {
    const { width, height, tileW, tileH } = this.dimensions();
    const hex = this.hexMetrics(width, height);
    this.drawTerrain(width, height, hex, time);
    this.drawScenery(width, height, tileW, tileH, time);
    this.drawKeeps(width, height, hex, time);
    this.drawFront(hex, time);
    this.drawAtmosphere(width, height, time);
  }

  private drawTerrain(width: number, height: number, hex: HexMetrics, time: number): void {
    this.terrain.clear();
    this.terrain.fillStyle(0x7c8f64, 1);
    this.terrain.fillRect(0, 0, width, height);
    this.drawSea(width, height, hex);

    for (let col = 0; col < HEX_COLS; col += 1) {
      for (let row = 0; row < HEX_ROWS; row += 1) {
        const center = this.hexCenter(col, row, hex);
        const owner = this.hexOwner(col, row, time);
        const base = this.hexTerrainColor(col, row);
        this.drawHex(this.terrain, center.x, center.y, hex.size, base, 0.98, 0x314124, 0.2);

        if (owner === DWARVES) {
          this.drawHex(this.terrain, center.x, center.y, hex.size * 0.86, 0x124bb4, 0.18, 0x124bb4, 0.12);
        } else {
          this.drawHex(this.terrain, center.x, center.y, hex.size * 0.86, 0xb30012, 0.18, 0xb30012, 0.12);
        }

        this.drawHexDetails(center.x, center.y, hex.size, col, row);
      }
    }

    this.drawOperationalLines(hex, time);
  }

  private drawScenery(
    width: number,
    height: number,
    tileW: number,
    tileH: number,
    time: number,
  ): void {
    this.scenery.clear();
    for (let i = 0; i < 28; i += 1) {
      this.drawMountain((0.04 + i * 0.025) * width, (0.09 + Math.sin(i) * 0.026) * height, tileW * 0.7);
    }
    this.drawVolcano(width * 0.86, height * 0.19, tileW * 0.8, tileH, time);
    this.drawRiver(width, height, time);
  }

  private drawKeeps(width: number, height: number, hex: HexMetrics, time: number): void {
    this.keeps.clear();
    this.drawFortress(width * 0.055, height * 0.55, hex.size * 0.7, 0xd5d1ad, 0x0036ff);
    this.drawFortress(width * 0.92, height * 0.55, hex.size * 0.7, 0x6d5943, 0xff0000);
    this.drawCrownKeep(width * 0.5, height * 0.52, hex.size * 0.78, time);
    this.drawGoalAura(width * 0.055, height * 0.53, time, 0x83d6ff);
    this.drawGoalAura(width * 0.945, height * 0.53, time, 0xff7048);
  }

  private drawFront(hex: HexMetrics, time: number): void {
    this.frontLine.clear();
    for (let row = 0; row < HEX_ROWS; row += 1) {
      const boundary = this.frontColumnForRow(row, time);
      const center = this.hexCenter(Math.floor(boundary), row, hex);
      this.frontLine.lineStyle(4, 0x0b1230, 0.78);
      this.frontLine.strokeCircle(center.x, center.y, hex.size * 0.56);
      this.frontLine.lineStyle(2, 0xffdf5c, 0.72);
      this.frontLine.strokeCircle(center.x, center.y, hex.size * 0.42);
      if (row % 2 === 0) {
        this.frontLine.fillStyle(0xffdf5c, 0.85);
        this.frontLine.fillRect(center.x - 2, center.y - hex.size * 0.58, 4, hex.size * 1.16);
      }
    }

    this.frontLine.lineStyle(5, 0xffdf5c, 0.38);
    this.frontLine.beginPath();
    for (let row = 0; row < HEX_ROWS; row += 1) {
      const center = this.hexCenter(Math.floor(this.frontColumnForRow(row, time)), row, hex);
      if (row === 0) {
        this.frontLine.moveTo(center.x, center.y);
      } else {
        this.frontLine.lineTo(center.x, center.y);
      }
    }
    this.frontLine.strokePath();
  }

  private drawAtmosphere(width: number, height: number, time: number): void {
    this.atmosphere.clear();
    this.atmosphere.fillStyle(0x0036ff, 0.035 + Math.sin(time / 760) * 0.012);
    this.atmosphere.fillRect(0, 0, width * 0.5, height);
    this.atmosphere.fillStyle(0xff0000, 0.038 + Math.cos(time / 740) * 0.012);
    this.atmosphere.fillRect(width * 0.5, 0, width * 0.5, height);
    this.atmosphere.lineStyle(1, 0x162312, 0.14);
    for (let i = 0; i < 44; i += 1) {
      const x = (i * 97 + time / 90) % width;
      this.atmosphere.lineBetween(x, 0, x + Math.sin(i) * 18, height);
    }
  }

  private createUnits(): void {
    for (let i = 0; i < 24; i += 1) {
      this.units.push(this.createUnit(DWARVES, i));
      this.units.push(this.createUnit(ORCS, i));
    }
  }

  private createUnit(side: number, index: number): UnitActor {
    const container = this.add.container(0, 0);
    const shadow = this.add.rectangle(3, 5, 26, 22, 0x000000, 0.35);
    const counter = this.add.image(0, 0, side === DWARVES ? "dwarf-counter" : "orc-counter");
    counter.setScale(1.18);
    const sprite = this.add.image(side === DWARVES ? -3 : 3, -8, side === DWARVES ? "dwarf-knight" : "orc-beast");
    sprite.setScale(side === DWARVES ? 0.58 : 0.62);
    sprite.setFlipX(side === ORCS);
    const label = this.add
      .text(0, 10, side === DWARVES ? "DW" : "OR", {
        fontFamily: "Courier New, monospace",
        fontSize: "9px",
        fontStyle: "900",
        color: "#ffffff",
        stroke: "#101010",
        strokeThickness: 2,
      })
      .setOrigin(0.5);
    container.add([shadow, counter, sprite, label]);
    this.unitLayer.add(container);

    const actor: UnitActor = {
      side,
      row: (index * 5 + side * 3) % HEX_ROWS,
      columnOffset: 1 + (index % 5),
      phase: pseudoRandom(index * 37 + side * 101) * Math.PI * 2,
      charge: 0,
      container,
    };

    return actor;
  }

  private updateUnits(time: number): void {
    const { width, height } = this.dimensions();
    const hex = this.hexMetrics(width, height);
    for (const unit of this.units) {
      const frontCol = Math.floor(this.frontColumnForRow(unit.row, time));
      const col =
        unit.side === DWARVES
          ? Phaser.Math.Clamp(frontCol - unit.columnOffset, 1, HEX_COLS - 2)
          : Phaser.Math.Clamp(frontCol + unit.columnOffset, 1, HEX_COLS - 2);
      const center = this.hexCenter(col, unit.row, hex);
      unit.container.x = center.x + unit.charge + Math.sin(time / 710 + unit.phase) * 3;
      unit.container.y = center.y + Math.sin(time / 180 + unit.phase) * 2;
      unit.container.setDepth(unit.container.y);
      unit.container.rotation = Math.sin(time / 290 + unit.phase) * 0.025;
      unit.container.setAlpha(unit.container.x > 24 && unit.container.x < width - 24 ? 1 : 0);
    }
  }

  private makeTextures(): void {
    const g = this.make.graphics({ x: 0, y: 0 });

    g.fillStyle(0x000000, 0);
    g.fillRect(0, 0, 64, 64);
    g.fillStyle(0x1f2d3e, 1);
    g.fillRect(21, 8, 22, 18);
    g.fillStyle(0xd9e3ef, 1);
    g.fillRect(18, 10, 28, 15);
    g.fillStyle(0x8794a4, 1);
    g.fillRect(22, 23, 21, 8);
    g.fillStyle(0xdb7b2d, 1);
    g.fillRect(23, 28, 18, 11);
    g.fillStyle(0xb91f2b, 1);
    g.fillRect(18, 34, 27, 19);
    g.fillStyle(0xd5dde6, 1);
    g.fillRect(16, 31, 32, 8);
    g.fillStyle(0x2a5eb8, 1);
    g.fillRect(6, 31, 17, 21);
    g.fillStyle(0xe9f5ff, 1);
    g.fillRect(12, 33, 4, 17);
    g.fillRect(8, 40, 13, 3);
    g.fillStyle(0xf2f5f6, 1);
    g.fillRect(48, 14, 4, 34);
    g.fillRect(44, 18, 13, 4);
    g.generateTexture("dwarf-knight", 64, 64);
    g.clear();

    g.fillStyle(0x000000, 0);
    g.fillRect(0, 0, 72, 64);
    g.fillStyle(0x1d5f30, 1);
    g.fillRect(15, 27, 35, 20);
    g.fillStyle(0x2f9349, 1);
    g.fillRect(24, 13, 33, 22);
    g.fillRect(8, 42, 20, 9);
    g.fillStyle(0xd5c48a, 1);
    g.fillRect(22, 32, 15, 13);
    g.fillStyle(0x3fb6df, 1);
    g.fillRect(31, 17, 19, 3);
    g.fillRect(30, 25, 21, 3);
    g.fillStyle(0xff3030, 1);
    g.fillRect(49, 18, 5, 5);
    g.fillStyle(0xf7efe0, 1);
    g.fillRect(57, 24, 6, 3);
    g.fillRect(57, 30, 6, 3);
    g.fillStyle(0x154421, 1);
    g.fillRect(1, 47, 16, 5);
    g.generateTexture("orc-beast", 72, 64);
    g.clear();

    this.drawCounterTexture(g, "dwarf-counter", 0x0036ff, 0x9bdfff);
    this.drawCounterTexture(g, "orc-counter", 0xff0000, 0xffb09b);

    g.fillStyle(0xffffff, 1);
    g.fillCircle(4, 4, 4);
    g.generateTexture("spark", 8, 8);
    g.destroy();
  }

  private drawCounterTexture(
    g: Phaser.GameObjects.Graphics,
    key: string,
    fill: number,
    accent: number,
  ): void {
    g.clear();
    g.fillStyle(0x000000, 0);
    g.fillRect(0, 0, 34, 30);
    g.fillStyle(0x050505, 0.48);
    g.fillRect(4, 5, 28, 23);
    g.fillStyle(fill, 1);
    g.fillRect(2, 2, 28, 22);
    g.lineStyle(2, 0xffffff, 0.86);
    g.strokeRect(2, 2, 28, 22);
    g.lineStyle(1, accent, 0.95);
    g.strokeRect(5, 5, 22, 16);
    g.lineBetween(8, 19, 24, 8);
    g.lineBetween(9, 8, 24, 19);
    g.generateTexture(key, 34, 30);
    g.clear();
  }

  private drawMountain(x: number, y: number, s: number): void {
    this.scenery.fillStyle(0x3f5265, 0.95);
    this.scenery.fillTriangle(x, y + s * 8, x + s * 4, y, x + s * 9, y + s * 8);
    this.scenery.fillStyle(0xe8f5ff, 0.9);
    this.scenery.fillTriangle(x + s * 4, y, x + s * 2.8, y + s * 2.8, x + s * 5.4, y + s * 2.7);
    this.scenery.fillStyle(0x1b2b38, 0.22);
    this.scenery.fillTriangle(x + s * 4, y, x + s * 9, y + s * 8, x + s * 5.4, y + s * 2.7);
  }

  private drawVolcano(x: number, y: number, s: number, tileH: number, time: number): void {
    this.scenery.fillStyle(0x24161a, 1);
    this.scenery.fillTriangle(x - s * 11, y + tileH * 22, x, y, x + s * 12, y + tileH * 22);
    this.scenery.fillStyle(0x3a2224, 1);
    this.scenery.fillTriangle(x - s * 5, y + tileH * 22, x + s * 2, y + tileH * 4, x + s * 12, y + tileH * 22);
    this.scenery.fillStyle(0xff5d2d, 0.95);
    this.scenery.fillRect(x - s * 1.8, y + tileH * 3, s * 3.6, tileH * 4.2);
    this.scenery.fillStyle(0xffb24d, 0.75);
    this.scenery.fillCircle(x + Math.sin(time / 310) * s, y + tileH * 5.5, s * 1.1);
    for (let i = 0; i < 5; i += 1) {
      this.scenery.fillStyle(0x1c1416, 0.22 - i * 0.025);
      this.scenery.fillCircle(
        x - s * 4 + i * s * 2 + Math.sin(time / 700 + i) * s,
        y - tileH * (4 + i * 1.7),
        s * (2.2 + i * 0.55),
      );
    }
  }

  private drawRiver(width: number, height: number, time: number): void {
    this.scenery.lineStyle(11, 0x3aaed6, 0.34);
    this.scenery.beginPath();
    this.scenery.moveTo(width * 0.18, 0);
    this.scenery.lineTo(width * 0.23 + Math.sin(time / 900) * 8, height * 0.26);
    this.scenery.lineTo(width * 0.31, height * 0.42);
    this.scenery.lineTo(width * 0.38, height);
    this.scenery.strokePath();
    this.scenery.lineStyle(3, 0xa9f0ff, 0.34);
    this.scenery.strokePath();
  }

  private drawFortress(x: number, y: number, s: number, wall: number, banner: number): void {
    this.keeps.fillStyle(0x000000, 0.28);
    this.keeps.fillEllipse(x + s * 4, y + s * 12, s * 17, s * 5);
    this.keeps.fillStyle(wall, 1);
    this.keeps.fillRect(x - s * 1.5, y - s * 5, s * 11, s * 15);
    this.keeps.fillRect(x - s * 4, y - s * 9, s * 3.7, s * 19);
    this.keeps.fillRect(x + s * 8, y - s * 9, s * 3.7, s * 19);
    for (let i = 0; i < 5; i += 1) {
      this.keeps.fillRect(x - s * 1.5 + i * s * 2.5, y - s * 7, s * 1.2, s * 2.5);
    }
    this.keeps.fillStyle(0x161b25, 1);
    this.keeps.fillRect(x + s * 2.7, y + s * 3, s * 2.5, s * 7);
    this.keeps.fillStyle(banner, 1);
    this.keeps.fillRect(x + s * 1.8, y - s * 12, s * 5.2, s * 2.2);
    this.keeps.fillStyle(0xffffff, 0.78);
    this.keeps.fillRect(x + s * 3, y - s * 4, s * 1.2, s * 1.2);
  }

  private drawCrownKeep(width: number, height: number, size: number, time: number): void {
    const x = width;
    const y = height;
    const s = size;
    const pulse = 0.48 + Math.sin(time / 190) * 0.17;
    this.keeps.lineStyle(3, 0xffd66e, pulse);
    this.keeps.strokeCircle(x, y, s * 12);
    this.keeps.lineStyle(1, 0xfff1b3, pulse * 0.65);
    this.keeps.strokeCircle(x, y, s * 16);
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2 + time / 2_500;
      this.keeps.lineBetween(x, y, x + Math.cos(a) * s * 15, y + Math.sin(a) * s * 15);
    }
    this.keeps.fillStyle(0x000000, 0.34);
    this.keeps.fillEllipse(x, y + s * 10, s * 24, s * 7);
    this.keeps.fillStyle(0x9c9489, 1);
    this.keeps.fillRect(x - s * 7, y - s * 4, s * 14, s * 13);
    this.keeps.fillRect(x - s * 10, y - s * 9, s * 4.2, s * 18);
    this.keeps.fillRect(x + s * 5.8, y - s * 9, s * 4.2, s * 18);
    this.keeps.fillRect(x - s * 3, y - s * 12, s * 6, s * 21);
    this.keeps.fillStyle(0x5e5c61, 1);
    this.keeps.fillRect(x - s * 1.8, y + s * 2, s * 3.6, s * 7);
    this.keeps.fillStyle(0xffd66e, 1);
    this.keeps.fillRect(x - s * 6.5, y - s * 12, s * 2, s * 3);
    this.keeps.fillRect(x - s * 1, y - s * 16, s * 2, s * 4);
    this.keeps.fillRect(x + s * 4.5, y - s * 12, s * 2, s * 3);
    this.keeps.fillTriangle(x - s * 7, y - s * 12, x - s * 5.5, y - s * 16, x - s * 4, y - s * 12);
    this.keeps.fillTriangle(x - s * 1.6, y - s * 16, x, y - s * 21, x + s * 1.6, y - s * 16);
    this.keeps.fillTriangle(x + s * 4, y - s * 12, x + s * 5.5, y - s * 16, x + s * 7, y - s * 12);
    this.keeps.lineStyle(2, 0xfff1b3, 0.5);
    this.keeps.lineBetween(x, y - s * 20, x, y - s * 25 - Math.sin(time / 220) * s * 0.9);
  }

  private drawGoalAura(x: number, y: number, time: number, color: number): void {
    const radius = 42 + Math.sin(time / 180) * 5;
    this.keeps.lineStyle(3, color, 0.72);
    this.keeps.strokeCircle(x, y, radius);
    this.keeps.lineStyle(1, 0xffffff, 0.45);
    this.keeps.strokeCircle(x, y, radius + 10);
  }

  private flashRing(x: number, y: number, color: number): void {
    const ring = this.add.circle(x, y, 8);
    ring.setStrokeStyle(4, color, 0.95);
    ring.setFillStyle(color, 0.05);
    ring.setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({
      targets: ring,
      radius: 96,
      alpha: 0,
      duration: 640,
      ease: "Cubic.easeOut",
      onComplete: () => ring.destroy(),
    });
  }

  private floatText(x: number, y: number, text: string, color: number): void {
    const label = this.add
      .text(x, y, text, {
        fontFamily: "Georgia, serif",
        fontSize: "24px",
        fontStyle: "900",
        color: `#${color.toString(16).padStart(6, "0")}`,
        stroke: "#05070c",
        strokeThickness: 5,
      })
      .setOrigin(0.5)
      .setDepth(10_000);
    this.tweens.add({
      targets: label,
      y: y - 70,
      alpha: 0,
      scale: 1.35,
      duration: 960,
      ease: "Cubic.easeOut",
      onComplete: () => label.destroy(),
    });
  }

  private drawSea(width: number, height: number, hex: HexMetrics): void {
    this.terrain.fillStyle(0x6f9da0, 0.95);
    this.terrain.beginPath();
    this.terrain.moveTo(0, 0);
    this.terrain.lineTo(width * 0.27, 0);
    this.terrain.lineTo(width * 0.22, height * 0.14);
    this.terrain.lineTo(width * 0.11, height * 0.16);
    this.terrain.lineTo(width * 0.04, height * 0.09);
    this.terrain.lineTo(0, height * 0.12);
    this.terrain.closePath();
    this.terrain.fillPath();

    this.terrain.beginPath();
    this.terrain.moveTo(width, height * 0.77);
    this.terrain.lineTo(width, height);
    this.terrain.lineTo(width * 0.67, height);
    this.terrain.lineTo(width * 0.71, height * 0.9);
    this.terrain.lineTo(width * 0.82, height * 0.84);
    this.terrain.closePath();
    this.terrain.fillPath();

    this.terrain.lineStyle(2, 0x2d5964, 0.35);
    this.terrain.strokeRect(hex.originX - hex.width, hex.originY - hex.height, width + hex.width * 2, height + hex.height * 2);
  }

  private drawOperationalLines(hex: HexMetrics, time: number): void {
    this.terrain.lineStyle(3, 0x6e6f4f, 0.42);
    this.terrain.beginPath();
    for (let i = 0; i < 12; i += 1) {
      const point = this.hexCenter(4 + i * 4, 21 - Math.floor(i / 2), hex);
      if (i === 0) {
        this.terrain.moveTo(point.x, point.y);
      } else {
        this.terrain.lineTo(point.x, point.y);
      }
    }
    this.terrain.strokePath();

    this.terrain.lineStyle(2, 0x3c7b8a, 0.58);
    this.terrain.beginPath();
    for (let i = 0; i < 17; i += 1) {
      const point = this.hexCenter(9 + i * 2, 2 + ((i * 3) % 20), hex);
      if (i === 0) {
        this.terrain.moveTo(point.x, point.y);
      } else {
        this.terrain.lineTo(point.x + Math.sin(time / 900 + i) * 2, point.y);
      }
    }
    this.terrain.strokePath();
  }

  private drawHexDetails(x: number, y: number, size: number, col: number, row: number): void {
    const n = pseudoRandom(col * 733 + row * 131 + SEED);
    if (n > 0.72) {
      this.terrain.lineStyle(1, 0x244222, 0.62);
      for (let i = 0; i < 3; i += 1) {
        const dx = (i - 1) * size * 0.22;
        this.terrain.lineBetween(x + dx - size * 0.16, y + size * 0.16, x + dx, y - size * 0.18);
        this.terrain.lineBetween(x + dx, y - size * 0.18, x + dx + size * 0.16, y + size * 0.16);
      }
    } else if (n < 0.12) {
      this.terrain.fillStyle(0x526e76, 0.36);
      this.terrain.fillRect(x - size * 0.34, y - size * 0.06, size * 0.68, size * 0.12);
      this.terrain.fillRect(x - size * 0.06, y - size * 0.34, size * 0.12, size * 0.68);
    } else if (n > 0.42 && n < 0.5) {
      this.terrain.lineStyle(1, 0x765f42, 0.54);
      this.terrain.lineBetween(x - size * 0.42, y + size * 0.2, x + size * 0.42, y - size * 0.2);
    }
  }

  private drawHex(
    target: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    size: number,
    fill: number,
    alpha: number,
    stroke: number,
    strokeAlpha: number,
  ): void {
    const points = this.hexPoints(x, y, size);
    target.fillStyle(fill, alpha);
    target.beginPath();
    target.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      target.lineTo(points[i].x, points[i].y);
    }
    target.closePath();
    target.fillPath();
    target.lineStyle(1, stroke, strokeAlpha);
    target.beginPath();
    target.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      target.lineTo(points[i].x, points[i].y);
    }
    target.closePath();
    target.strokePath();
  }

  private hexPoints(x: number, y: number, size: number): Phaser.Math.Vector2[] {
    const points: Phaser.Math.Vector2[] = [];
    for (let i = 0; i < 6; i += 1) {
      const angle = Phaser.Math.DegToRad(60 * i);
      points.push(new Phaser.Math.Vector2(x + size * Math.cos(angle), y + size * Math.sin(angle)));
    }
    return points;
  }

  private hexCenter(col: number, row: number, hex: HexMetrics): Phaser.Math.Vector2 {
    return new Phaser.Math.Vector2(
      hex.originX + col * hex.xStep,
      hex.originY + row * hex.yStep + (col % 2) * (hex.yStep / 2),
    );
  }

  private hexMetrics(width: number, height: number): HexMetrics {
    const widthSize = width / (HEX_COLS * 1.5 + 0.5);
    const heightSize = height / ((HEX_ROWS + 0.75) * Math.sqrt(3));
    const size = Math.max(7, Math.min(widthSize, heightSize) * 1.12);
    const hexWidth = size * 2;
    const hexHeight = Math.sqrt(3) * size;
    const mapWidth = (HEX_COLS - 1) * size * 1.5 + hexWidth;
    const mapHeight = (HEX_ROWS + 0.5) * hexHeight;
    return {
      size,
      width: hexWidth,
      height: hexHeight,
      xStep: size * 1.5,
      yStep: hexHeight,
      originX: (width - mapWidth) / 2 + size,
      originY: (height - mapHeight) / 2 + hexHeight * 0.62,
    };
  }

  private hexOwner(col: number, row: number, time: number): number {
    return col <= this.frontColumnForRow(row, time) ? DWARVES : ORCS;
  }

  private frontColumnForRow(row: number, time: number): number {
    const base = (this.renderedFront / TOTAL_TILES) * (HEX_COLS - 1);
    const noise = (pseudoRandom(row * 101 + SEED) - 0.5) * 5.4;
    const wave = Math.sin(time / 950 + row * 0.63) * 1.1;
    return Phaser.Math.Clamp(base + noise + wave, 0, HEX_COLS - 1);
  }

  private hexTerrainColor(col: number, row: number): number {
    const n = pseudoRandom(col * 19 + row * 79 + SEED);
    if (col < 8 && row < 5) {
      return 0x6f9da0;
    }
    if (col > 38 && row > 23) {
      return 0x6f9da0;
    }
    if (n > 0.84) {
      return 0x5d7446;
    }
    if (n > 0.68) {
      return 0x8fa06b;
    }
    if (n < 0.13) {
      return 0x6f8e74;
    }
    if (n < 0.23) {
      return 0xb49a6e;
    }
    return 0x9aaa6f;
  }

  private dimensions(): { width: number; height: number; tileW: number; tileH: number } {
    const width = Math.max(320, this.scale.width);
    const height = Math.max(240, this.scale.height);
    return {
      width,
      height,
      tileW: width / FIELD_WIDTH,
      tileH: height / FIELD_HEIGHT,
    };
  }

}

function readTilesInput(): bigint {
  const parsed = Math.max(1, Math.min(5_000, Math.floor(Number(tilesInput.value) || 1)));
  tilesInput.value = String(parsed);
  return BigInt(parsed);
}

function formatClock(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatEth(value: bigint): string {
  return Number(formatEther(value)).toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  });
}

function readContract(): Contract {
  return new Contract(configuredAddress, SIEGE_ABI, provider);
}

function writeContract(): Contract {
  if (!signer) {
    throw new Error("Wallet not connected");
  }
  return new Contract(configuredAddress, SIEGE_ABI, signer);
}

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function setActionsDisabled(disabled: boolean): void {
  pushDwarvesButton.disabled = disabled || !hasContract;
  pushOrcsButton.disabled = disabled || !hasContract;
  claimButton.disabled = disabled || !hasContract;
}

function pseudoRandom(input: number): number {
  const x = Math.sin(input * 12.9898) * 43_758.5453;
  return x - Math.floor(x);
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing #${id}`);
  }
  return node as T;
}

function startBattlefield(): void {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: "battlefield",
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: "#040712",
    pixelArt: true,
    render: {
      antialias: false,
      roundPixels: true,
    },
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: BattleScene,
  });
}

startBattlefield();
void initialise();
