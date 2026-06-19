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
  lane: number;
  offset: number;
  phase: number;
  charge: number;
  container: Phaser.GameObjects.Container;
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
    const x = this.frontX(width);
    const y = height * (0.28 + pseudoRandom(this.currentState.front + SEED) * 0.5);
    const color = faction === DWARVES ? 0x83d6ff : 0xff7048;
    const sparks = this.add.particles(x, y, "spark", {
      lifespan: { min: 360, max: 920 },
      speed: { min: 80, max: 410 },
      angle: faction === DWARVES ? { min: -60, max: 55 } : { min: 125, max: 235 },
      gravityY: 320,
      scale: { start: 1.35, end: 0 },
      alpha: { start: 0.95, end: 0 },
      tint: [color, 0xffd66e, 0x8e1424],
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
        charge: faction === DWARVES ? 34 : -34,
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
    this.drawTerrain(width, height, tileW, tileH);
    this.drawScenery(width, height, tileW, tileH, time);
    this.drawKeeps(width, height, tileW, tileH, time);
    this.drawFront(width, height, tileH, time);
    this.drawAtmosphere(width, height, time);
  }

  private drawTerrain(width: number, height: number, tileW: number, tileH: number): void {
    this.terrain.clear();
    this.terrain.fillStyle(0x040712, 1);
    this.terrain.fillRect(0, 0, width, height);

    for (let x = 0; x < FIELD_WIDTH; x += 1) {
      for (let y = 0; y < FIELD_HEIGHT; y += 1) {
        const index = x * FIELD_HEIGHT + y;
        const dwarfOwned = index < this.renderedFront;
        const noise = pseudoRandom(x * 29 + y * 83 + SEED);
        const palette = dwarfOwned
          ? [0x24563d, 0x2f7046, 0x3b8350, 0x1e4962, 0x486c39]
          : [0x522a27, 0x623027, 0x3b2630, 0x714128, 0x27242d];
        const color = palette[Math.floor(noise * palette.length)];
        const alpha = 0.82 + pseudoRandom(y * 47 + x * 11) * 0.16;
        this.terrain.fillStyle(color, alpha);
        this.terrain.fillRect(x * tileW, y * tileH, Math.ceil(tileW), Math.ceil(tileH));
      }
    }

    this.terrain.fillStyle(0x061226, 0.42);
    this.terrain.fillRect(0, 0, width, height * 0.12);
    this.terrain.fillStyle(0x000000, 0.22);
    this.terrain.fillRect(0, height * 0.82, width, height * 0.18);
    this.drawDiagonalRoad(width, height);
  }

  private drawDiagonalRoad(width: number, height: number): void {
    this.terrain.lineStyle(18, 0x716252, 0.28);
    this.terrain.beginPath();
    this.terrain.moveTo(width * 0.04, height * 0.74);
    this.terrain.lineTo(width * 0.32, height * 0.58);
    this.terrain.lineTo(width * 0.51, height * 0.52);
    this.terrain.lineTo(width * 0.71, height * 0.47);
    this.terrain.lineTo(width * 0.96, height * 0.24);
    this.terrain.strokePath();
    this.terrain.lineStyle(4, 0xd8c895, 0.18);
    this.terrain.strokePath();
  }

  private drawScenery(
    width: number,
    height: number,
    tileW: number,
    tileH: number,
    time: number,
  ): void {
    this.scenery.clear();
    for (let i = 0; i < 18; i += 1) {
      this.drawMountain((0.04 + i * 0.026) * width, (0.08 + Math.sin(i) * 0.035) * height, tileW);
    }
    for (let i = 0; i < 44; i += 1) {
      this.drawPine(
        (0.07 + ((i * 17) % 43) / 100) * width,
        (0.25 + ((i * 31) % 50) / 100) * height,
        tileW * (1.1 + pseudoRandom(i) * 0.9),
      );
    }
    for (let i = 0; i < 30; i += 1) {
      this.drawDeadTree(
        (0.67 + ((i * 13) % 28) / 100) * width,
        (0.2 + ((i * 23) % 58) / 100) * height,
        tileW * (1 + pseudoRandom(i + 5) * 0.75),
      );
    }
    this.drawVolcano(width * 0.84, height * 0.18, tileW, tileH, time);
    this.drawRiver(width, height, time);
  }

  private drawKeeps(width: number, height: number, tileW: number, tileH: number, time: number): void {
    this.keeps.clear();
    this.drawFortress(width * 0.055, height * 0.53, tileW * 1.18, 0x9cb7cf, 0x2868be);
    this.drawFortress(width * 0.92, height * 0.53, tileW * 1.18, 0x54414a, 0xb8422a);
    this.drawCrownKeep(width * 0.5, height * 0.51, tileW, tileH, time);
    this.drawGoalAura(width * 0.055, height * 0.53, time, 0x83d6ff);
    this.drawGoalAura(width * 0.945, height * 0.53, time, 0xff7048);
  }

  private drawFront(width: number, height: number, tileH: number, time: number): void {
    const baseX = this.frontX(width);
    this.frontLine.clear();
    this.frontLine.lineStyle(18, 0xffbc45, 0.12);
    this.traceFront(baseX, tileH, time);
    this.frontLine.lineStyle(9, 0xffd66e, 0.34);
    this.traceFront(baseX, tileH, time + 44);
    this.frontLine.lineStyle(4, 0xfff0b0, 0.92);
    this.traceFront(baseX, tileH, time + 88);

    for (let i = 0; i < 18; i += 1) {
      const y = (i / 17) * height;
      const wobble = this.frontWobble(i * 5, time);
      this.frontLine.fillStyle(i % 2 === 0 ? 0xffd66e : 0x83d6ff, 0.45);
      this.frontLine.fillCircle(baseX + wobble, y, 2.5 + Math.sin(time / 130 + i) * 1.2);
    }
  }

  private traceFront(baseX: number, tileH: number, time: number): void {
    this.frontLine.beginPath();
    for (let y = 0; y <= FIELD_HEIGHT; y += 1) {
      const x = baseX + this.frontWobble(y, time);
      if (y === 0) {
        this.frontLine.moveTo(x, y * tileH);
      } else {
        this.frontLine.lineTo(x, y * tileH);
      }
    }
    this.frontLine.strokePath();
  }

  private drawAtmosphere(width: number, height: number, time: number): void {
    this.atmosphere.clear();
    this.atmosphere.fillStyle(0x83d6ff, 0.04 + Math.sin(time / 760) * 0.015);
    this.atmosphere.fillRect(0, 0, width * 0.48, height);
    this.atmosphere.fillStyle(0xff7048, 0.05 + Math.cos(time / 740) * 0.018);
    this.atmosphere.fillRect(width * 0.52, 0, width * 0.48, height);
    this.atmosphere.lineStyle(1, 0xffffff, 0.035);
    for (let i = 0; i < 32; i += 1) {
      const y = ((i * 97 + time / 80) % height) - 20;
      this.atmosphere.lineBetween(0, y, width, y + Math.sin(i) * 26);
    }
  }

  private createUnits(): void {
    for (let i = 0; i < 14; i += 1) {
      this.units.push(this.createUnit(DWARVES, i));
      this.units.push(this.createUnit(ORCS, i));
    }
  }

  private createUnit(side: number, index: number): UnitActor {
    const container = this.add.container(0, 0);
    const shadow = this.add.ellipse(0, 19, 42, 13, 0x000000, 0.32);
    const sprite = this.add.image(0, 0, side === DWARVES ? "dwarf-knight" : "orc-beast");
    sprite.setScale(side === DWARVES ? 1.45 : 1.55);
    sprite.setFlipX(side === ORCS);
    container.add([shadow, sprite]);
    this.unitLayer.add(container);

    const actor: UnitActor = {
      side,
      lane: index,
      offset: 42 + (index % 4) * 31 + pseudoRandom(index * 13 + side) * 42,
      phase: pseudoRandom(index * 37 + side * 101) * Math.PI * 2,
      charge: 0,
      container,
    };

    return actor;
  }

  private updateUnits(time: number): void {
    const { width, height } = this.dimensions();
    const front = this.frontX(width);
    for (const unit of this.units) {
      const lanePct = 0.16 + ((unit.lane * 0.061) % 0.68);
      const squadDrift = Math.sin(time / 710 + unit.phase) * 10;
      const sideSign = unit.side === DWARVES ? -1 : 1;
      unit.container.x = front + sideSign * unit.offset + unit.charge + squadDrift;
      unit.container.y = lanePct * height + Math.sin(time / 180 + unit.phase) * 5;
      unit.container.setDepth(unit.container.y);
      unit.container.rotation = Math.sin(time / 290 + unit.phase) * 0.035;
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

    g.fillStyle(0xffffff, 1);
    g.fillCircle(4, 4, 4);
    g.generateTexture("spark", 8, 8);
    g.destroy();
  }

  private drawMountain(x: number, y: number, s: number): void {
    this.scenery.fillStyle(0x3f5265, 0.95);
    this.scenery.fillTriangle(x, y + s * 8, x + s * 4, y, x + s * 9, y + s * 8);
    this.scenery.fillStyle(0xe8f5ff, 0.9);
    this.scenery.fillTriangle(x + s * 4, y, x + s * 2.8, y + s * 2.8, x + s * 5.4, y + s * 2.7);
    this.scenery.fillStyle(0x1b2b38, 0.22);
    this.scenery.fillTriangle(x + s * 4, y, x + s * 9, y + s * 8, x + s * 5.4, y + s * 2.7);
  }

  private drawPine(x: number, y: number, s: number): void {
    this.scenery.fillStyle(0x261711, 1);
    this.scenery.fillRect(x + s * 1.6, y + s * 3.1, s * 0.7, s * 3.8);
    this.scenery.fillStyle(0x143d2b, 0.95);
    this.scenery.fillTriangle(x, y + s * 4.8, x + s * 2, y, x + s * 4, y + s * 4.8);
    this.scenery.fillStyle(0x246842, 0.9);
    this.scenery.fillTriangle(x + s * 0.3, y + s * 3.2, x + s * 2, y + s * 0.8, x + s * 3.7, y + s * 3.2);
  }

  private drawDeadTree(x: number, y: number, s: number): void {
    this.scenery.lineStyle(Math.max(2, s * 0.32), 0x171014, 0.9);
    this.scenery.beginPath();
    this.scenery.moveTo(x + s * 2, y + s * 6.5);
    this.scenery.lineTo(x + s * 2, y);
    this.scenery.moveTo(x + s * 2, y + s * 2);
    this.scenery.lineTo(x, y + s * 0.7);
    this.scenery.moveTo(x + s * 2, y + s * 3.2);
    this.scenery.lineTo(x + s * 4.2, y + s * 1.2);
    this.scenery.strokePath();
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

  private drawCrownKeep(width: number, height: number, tileW: number, tileH: number, time: number): void {
    const x = width;
    const y = height;
    const s = tileW * 1.15;
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
    this.keeps.lineBetween(x, y - s * 20, x, y - s * 26 - Math.sin(time / 220) * tileH);
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

  private frontX(width: number): number {
    return Phaser.Math.Clamp((this.renderedFront / TOTAL_TILES) * width, 0, width);
  }

  private frontWobble(row: number, time: number): number {
    return (pseudoRandom(row * 101 + SEED) - 0.5) * 26 + Math.sin(time / 310 + row * 0.7) * 5;
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
