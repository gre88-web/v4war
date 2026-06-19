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

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  text?: string;
};

const state: GameState = {
  front: 5_000,
  jackpot: 0n,
  bonusPool: 0n,
  deadline: 0,
  phase: 0,
  winner: 255,
};

const particles: Particle[] = [];
let lastJackpot = 0n;
let shake = 0;

const canvas = element<HTMLCanvasElement>("battlefield");
const ctx = canvasContext(canvas);

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

void initialise();
requestAnimationFrame(render);

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

  if (jackpot > lastJackpot) {
    jackpotEl.classList.add("flash");
    window.setTimeout(() => jackpotEl.classList.remove("flash"), 450);
    burstAtFront(`+Ξ${formatEth(jackpot - lastJackpot)}`);
  }
  if (Math.abs(state.front - previousFront) > 20) {
    shake = Math.min(18, Math.abs(state.front - previousFront) / 20);
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
  contract.on("Pushed", (_who, _faction, _tiles, newFront, paid) => {
    state.front = Number(newFront);
    burstAtFront(`+Ξ${formatEth(paid ?? 0n)}`);
    void refreshState();
  });

  contract.on("Resolved", (winningFaction, _jackpot, bonusAwarded) => {
    showVictory(Number(winningFaction), Boolean(bonusAwarded));
    shake = 22;
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

function render(now: number): void {
  const tileW = canvas.width / FIELD_WIDTH;
  const tileH = canvas.height / FIELD_HEIGHT;
  const offsetX = shake > 0 ? (Math.random() - 0.5) * shake : 0;
  const offsetY = shake > 0 ? (Math.random() - 0.5) * shake : 0;
  shake *= 0.9;
  if (shake < 0.1) {
    shake = 0;
  }

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(-32, -32, canvas.width + 64, canvas.height + 64);
  drawTiles(tileW, tileH);
  drawTerrain(tileW, tileH);
  drawKeeps(tileW, tileH, now);
  drawSprites(tileW, tileH, now);
  drawFront(tileH, now);
  drawParticles();
  ctx.restore();
  requestAnimationFrame(render);
}

function drawTiles(tileW: number, tileH: number): void {
  for (let x = 0; x < FIELD_WIDTH; x += 1) {
    for (let y = 0; y < FIELD_HEIGHT; y += 1) {
      const index = x * FIELD_HEIGHT + y;
      const dwarfOwned = index < state.front;
      const speckle = pseudoRandom(x * 19 + y * 73 + SEED);
      ctx.fillStyle = dwarfOwned
        ? speckle > 0.72
          ? "#477934"
          : "#5c9f46"
        : speckle > 0.68
          ? "#41383b"
          : "#6d5147";
      ctx.fillRect(x * tileW, y * tileH, Math.ceil(tileW), Math.ceil(tileH));
    }
  }
}

function drawTerrain(tileW: number, tileH: number): void {
  for (let i = 0; i < 17; i += 1) {
    const x = 8 + i * 3;
    const y = 10 + Math.sin(i) * 4;
    drawMountain(x * tileW, y * tileH, tileW);
  }
  for (let i = 0; i < 34; i += 1) {
    drawTree((10 + (i * 7) % 45) * tileW, (24 + (i * 11) % 48) * tileH, tileW);
  }
  for (let i = 0; i < 22; i += 1) {
    drawDeadTree((80 + (i * 5) % 35) * tileW, (15 + (i * 13) % 55) * tileH, tileW);
  }
  drawVolcano(103 * tileW, 13 * tileH, tileW, tileH);
}

function drawKeeps(tileW: number, tileH: number, now: number): void {
  drawCastle(3 * tileW, 34 * tileH, tileW, "#9aa8c8", "#b84032");
  drawCastle(116 * tileW, 34 * tileH, tileW, "#463940", "#235d2d");
  drawCrownKeep(58 * tileW, 34 * tileH, tileW, now);
  drawGoalRing(5 * tileW, 40 * tileH, now, "#7fe0ff");
  drawGoalRing(120 * tileW, 40 * tileH, now, "#ffb34d");
}

function drawFront(tileH: number, now: number): void {
  const baseX = (state.front / TOTAL_TILES) * canvas.width;
  ctx.save();
  ctx.lineWidth = 5;
  ctx.shadowColor = "#ffd45e";
  ctx.shadowBlur = 18 + Math.sin(now / 90) * 8;
  ctx.strokeStyle = "#ffd45e";
  ctx.beginPath();
  for (let y = 0; y <= FIELD_HEIGHT; y += 1) {
    const wobble = (pseudoRandom(y * 101 + SEED) - 0.5) * 26 + Math.sin(now / 300 + y) * 4;
    const x = baseX + wobble;
    if (y === 0) {
      ctx.moveTo(x, y * tileH);
    } else {
      ctx.lineTo(x, y * tileH);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawSprites(tileW: number, tileH: number, now: number): void {
  const frontX = (state.front / TOTAL_TILES) * canvas.width;
  for (let i = 0; i < 9; i += 1) {
    const y = (9 + i * 8 + Math.sin(now / 220 + i) * 2) * tileH;
    drawDwarf(frontX - (18 + (i % 3) * 10), y, tileW * 1.7);
    drawOrc(frontX + (8 + (i % 3) * 12), y + Math.cos(now / 180 + i) * 4, tileW * 1.8);
  }
}

function drawParticles(): void {
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.04;
    p.life -= 1;
    ctx.globalAlpha = Math.max(0, p.life / 45);
    ctx.fillStyle = p.color;
    if (p.text) {
      ctx.font = "bold 18px monospace";
      ctx.fillText(p.text, p.x, p.y);
    } else {
      ctx.fillRect(p.x, p.y, 4, 4);
    }
    ctx.globalAlpha = 1;
    if (p.life <= 0) {
      particles.splice(i, 1);
    }
  }
}

function drawMountain(x: number, y: number, s: number): void {
  ctx.fillStyle = "#5b6472";
  ctx.beginPath();
  ctx.moveTo(x, y + s * 8);
  ctx.lineTo(x + s * 4, y);
  ctx.lineTo(x + s * 8, y + s * 8);
  ctx.fill();
  ctx.fillStyle = "#edf7ff";
  ctx.beginPath();
  ctx.moveTo(x + s * 4, y);
  ctx.lineTo(x + s * 2.7, y + s * 2.8);
  ctx.lineTo(x + s * 5.1, y + s * 2.6);
  ctx.fill();
}

function drawTree(x: number, y: number, s: number): void {
  ctx.fillStyle = "#3b241d";
  ctx.fillRect(x + s * 1.6, y + s * 3, s, s * 3);
  ctx.fillStyle = "#245b31";
  ctx.fillRect(x, y + s, s * 4, s * 3);
  ctx.fillStyle = "#34723f";
  ctx.fillRect(x + s * 0.7, y, s * 2.6, s * 2);
}

function drawDeadTree(x: number, y: number, s: number): void {
  ctx.strokeStyle = "#1d1716";
  ctx.lineWidth = Math.max(2, s * 0.4);
  ctx.beginPath();
  ctx.moveTo(x + s * 2, y + s * 6);
  ctx.lineTo(x + s * 2, y);
  ctx.moveTo(x + s * 2, y + s * 2);
  ctx.lineTo(x, y + s);
  ctx.moveTo(x + s * 2, y + s * 3);
  ctx.lineTo(x + s * 4, y + s * 1.2);
  ctx.stroke();
}

function drawVolcano(x: number, y: number, s: number, tileH: number): void {
  ctx.fillStyle = "#2b2024";
  ctx.beginPath();
  ctx.moveTo(x - s * 8, y + tileH * 18);
  ctx.lineTo(x, y);
  ctx.lineTo(x + s * 8, y + tileH * 18);
  ctx.fill();
  ctx.fillStyle = "#ff5a2f";
  ctx.fillRect(x - s * 1.5, y + tileH * 2, s * 3, tileH * 3);
  ctx.fillStyle = "rgba(30, 20, 20, 0.55)";
  ctx.fillRect(x - s * 4, y - tileH * 7, s * 8, tileH * 6);
}

function drawCastle(x: number, y: number, s: number, wall: string, flag: string): void {
  ctx.fillStyle = wall;
  ctx.fillRect(x, y, s * 8, s * 11);
  ctx.fillRect(x - s * 2, y - s * 3, s * 3, s * 14);
  ctx.fillRect(x + s * 7, y - s * 3, s * 3, s * 14);
  ctx.fillStyle = "#202936";
  ctx.fillRect(x + s * 3, y + s * 6, s * 2, s * 5);
  ctx.fillStyle = flag;
  ctx.fillRect(x + s * 2, y - s * 6, s * 5, s * 2);
}

function drawCrownKeep(x: number, y: number, s: number, now: number): void {
  ctx.save();
  ctx.strokeStyle = `rgba(255, 215, 80, ${0.45 + Math.sin(now / 180) * 0.2})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x + s * 5, y + s * 5, s * 9, 0, Math.PI * 2);
  ctx.stroke();
  drawCastle(x, y, s, "#9c9488", "#ffd64a");
  ctx.fillStyle = "#ffd64a";
  ctx.fillRect(x + s * 2, y - s * 3, s, s * 2);
  ctx.fillRect(x + s * 4, y - s * 5, s, s * 4);
  ctx.fillRect(x + s * 6, y - s * 3, s, s * 2);
  ctx.restore();
}

function drawGoalRing(x: number, y: number, now: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.setLineDash([8, 6]);
  ctx.lineDashOffset = -now / 45;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, 34, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = "bold 14px monospace";
  ctx.fillStyle = color;
  ctx.fillText("★GOAL", x - 24, y - 40);
  ctx.restore();
}

function drawDwarf(x: number, y: number, s: number): void {
  ctx.fillStyle = "#d9792b";
  ctx.fillRect(x + s * 2, y + s * 4, s * 2, s * 2);
  ctx.fillStyle = "#cfd7df";
  ctx.fillRect(x + s * 1.4, y, s * 3, s * 3);
  ctx.fillRect(x + s * 1, y + s * 3, s * 4, s * 5);
  ctx.fillStyle = "#9d1f28";
  ctx.fillRect(x + s * 1.4, y + s * 5, s * 3, s * 3);
  ctx.fillStyle = "#244b9b";
  ctx.fillRect(x - s * 0.5, y + s * 4, s * 2, s * 4);
  ctx.fillStyle = "#e7edf5";
  ctx.fillRect(x + s * 0.1, y + s * 5, s * 0.4, s * 2.5);
  ctx.fillRect(x - s * 0.2, y + s * 5.9, s * 1.2, s * 0.4);
  ctx.fillStyle = "#edf1f5";
  ctx.fillRect(x + s * 4.6, y - s * 1, s * 0.6, s * 6);
}

function drawOrc(x: number, y: number, s: number): void {
  ctx.fillStyle = "#2f8d42";
  ctx.fillRect(x + s * 1, y + s * 2, s * 5, s * 5);
  ctx.fillRect(x + s * 4, y, s * 4, s * 3);
  ctx.fillStyle = "#d7c894";
  ctx.fillRect(x + s * 2, y + s * 3, s * 2, s * 3);
  ctx.fillStyle = "#4da3d9";
  ctx.fillRect(x + s * 4.7, y + s * 0.7, s * 2.2, s * 0.5);
  ctx.fillRect(x + s * 4.2, y + s * 1.7, s * 2.4, s * 0.5);
  ctx.fillStyle = "#e6322b";
  ctx.fillRect(x + s * 6.4, y + s * 0.8, s * 0.7, s * 0.7);
  ctx.fillStyle = "#1f5f30";
  ctx.fillRect(x - s, y + s * 6, s * 3, s);
}

function burstAtFront(text: string): void {
  const baseX = (state.front / TOTAL_TILES) * canvas.width;
  const baseY = canvas.height * (0.25 + pseudoRandom(state.front + SEED) * 0.5);
  particles.push({ x: baseX, y: baseY, vx: 0, vy: -0.7, life: 45, color: "#ffd45e", text });
  for (let i = 0; i < 28; i += 1) {
    particles.push({
      x: baseX,
      y: baseY,
      vx: (Math.random() - 0.5) * 4,
      vy: (Math.random() - 0.8) * 4,
      life: 20 + Math.random() * 25,
      color: Math.random() > 0.5 ? "#8b1018" : "#ffd45e",
    });
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

function canvasContext(node: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = node.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context unavailable");
  }
  return context;
}
