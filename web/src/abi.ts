export const SIEGE_ABI = [
  {
    type: "function",
    name: "gameState",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "front", type: "uint256" },
      { name: "jackpot", type: "uint256" },
      { name: "bonusPool", type: "uint256" },
      { name: "deadline", type: "uint64" },
      { name: "phase", type: "uint8" },
      { name: "winner", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "pricePerTile",
    stateMutability: "view",
    inputs: [{ name: "faction", type: "uint8" }],
    outputs: [{ name: "wei_", type: "uint256" }],
  },
  {
    type: "function",
    name: "costForTiles",
    stateMutability: "view",
    inputs: [
      { name: "faction", type: "uint8" },
      { name: "tiles", type: "uint256" },
    ],
    outputs: [{ name: "cost", type: "uint256" }],
  },
  {
    type: "function",
    name: "push",
    stateMutability: "payable",
    inputs: [{ name: "faction", type: "uint8" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "event",
    name: "Pushed",
    inputs: [
      { name: "who", type: "address", indexed: true },
      { name: "faction", type: "uint8", indexed: true },
      { name: "tiles", type: "uint256", indexed: false },
      { name: "newFront", type: "uint256", indexed: false },
      { name: "paid", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Resolved",
    inputs: [
      { name: "winner", type: "uint8", indexed: true },
      { name: "jackpot", type: "uint256", indexed: false },
      { name: "bonusAwarded", type: "bool", indexed: false },
    ],
  },
] as const;
