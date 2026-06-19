// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Siege of the Crown
/// @notice One-dimensional, two-faction FOMO war game. The chain stores only the frontline.
contract SiegeOfTheCrown {
    enum Phase {
        ACTIVE,
        RESOLVED
    }

    struct Config {
        address treasury;
        uint256 totalTiles;
        uint256 start;
        uint256 baseCost;
        uint256 escalation;
        uint16 feeBps;
        uint16 bonusBps;
        uint64 initialClock;
        uint64 extend;
        uint64 maxClock;
    }

    struct RoundResolution {
        uint8 winner;
        bool bonusAwarded;
        bool resolved;
        uint256 payoutPool;
        uint256 totalWinnerContrib;
    }

    uint8 public constant DWARVES = 0;
    uint8 public constant ORCS = 1;
    uint8 public constant NO_WINNER = type(uint8).max;
    uint16 public constant BPS_DENOMINATOR = 10_000;

    uint256 public immutable TOTAL_TILES;
    uint256 public immutable START;
    uint256 public immutable MIDLINE;
    uint256 public immutable BASE_COST;
    uint256 public immutable ESCALATION;
    uint256 public immutable ESCALATION_COST_PER_DEPTH;
    uint16 public immutable FEE_BPS;
    uint16 public immutable BONUS_BPS;
    uint256 public immutable BONUS_THRESHOLD;
    uint64 public immutable INITIAL_CLOCK;
    uint64 public immutable EXTEND;
    uint64 public immutable MAX_CLOCK;

    address public owner;
    address public treasury;
    bool public paused;

    uint256 public currentRound;
    uint256 public front;
    uint256 public jackpot;
    uint256 public bonusPool;
    uint64 public deadline;
    Phase public phase;
    uint8 public winner = NO_WINNER;
    bool public winnerHit70;
    uint256 public treasuryCredit;

    mapping(uint256 round => mapping(address player => mapping(uint8 faction => uint256 amount)))
        private _contrib;
    mapping(uint256 round => mapping(uint8 faction => uint256 amount)) public totalContrib;
    mapping(uint256 round => RoundResolution result) public roundResolution;

    uint256 private _locked = 1;

    event Pushed(
        address indexed who,
        uint8 indexed faction,
        uint256 tiles,
        uint256 newFront,
        uint256 paid
    );
    event Resolved(uint8 indexed winner, uint256 jackpot, bool bonusAwarded);
    event Claimed(address indexed who, uint256 amount);
    event NewRound(uint256 indexed roundId, uint256 rolloverBonus, uint64 deadline);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(bool paused);
    event TreasurySet(address indexed treasury);
    event TreasuryWithdrawn(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    modifier nonReentrant() {
        require(_locked == 1, "REENTRANCY");
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier whenActive() {
        require(phase == Phase.ACTIVE, "NOT_ACTIVE");
        require(!paused, "PAUSED");
        require(block.timestamp < deadline, "CURSE_EXPIRED");
        _;
    }

    constructor(Config memory config) {
        require(config.treasury != address(0), "BAD_TREASURY");
        require(config.totalTiles > 0, "BAD_TOTAL");
        require(config.start > 0 && config.start < config.totalTiles, "BAD_START");
        require(config.start * 2 == config.totalTiles, "START_NOT_MIDLINE");
        require(config.baseCost > 0, "BAD_BASE_COST");
        require(config.feeBps + config.bonusBps <= BPS_DENOMINATOR, "BAD_BPS");
        require(config.initialClock > 0, "BAD_INITIAL_CLOCK");
        require(config.extend > 0, "BAD_EXTEND");
        require(config.maxClock > 0, "BAD_MAX_CLOCK");

        owner = msg.sender;
        treasury = config.treasury;

        TOTAL_TILES = config.totalTiles;
        START = config.start;
        MIDLINE = config.totalTiles / 2;
        BASE_COST = config.baseCost;
        ESCALATION = config.escalation;
        ESCALATION_COST_PER_DEPTH =
            (config.baseCost * config.escalation) / (config.totalTiles / 2);
        FEE_BPS = config.feeBps;
        BONUS_BPS = config.bonusBps;
        BONUS_THRESHOLD = (config.totalTiles * 70) / 100;
        INITIAL_CLOCK = config.initialClock;
        EXTEND = config.extend;
        MAX_CLOCK = config.maxClock;

        front = config.start;
        deadline = uint64(block.timestamp + config.initialClock);

        emit OwnershipTransferred(address(0), msg.sender);
        emit TreasurySet(config.treasury);
        emit NewRound(0, 0, deadline);
    }

    receive() external payable {
        revert("DIRECT_ETH_DISABLED");
    }

    function push(uint8 faction) external payable nonReentrant whenActive {
        _validateFaction(faction);
        require(msg.value > 0, "NO_VALUE");

        (uint256 tiles, uint256 cost) = quote(faction, msg.value);
        require(tiles > 0, "NO_TILES");
        require(cost == msg.value, "INEXACT_PAYMENT");

        uint256 fee = (msg.value * FEE_BPS) / BPS_DENOMINATOR;
        uint256 net = msg.value - fee;
        uint256 bonusCut = (net * BONUS_BPS) / BPS_DENOMINATOR;
        uint256 jackpotCut = net - bonusCut;

        treasuryCredit += fee;
        bonusPool += bonusCut;
        jackpot += jackpotCut;
        _contrib[currentRound][msg.sender][faction] += net;
        totalContrib[currentRound][faction] += net;

        if (faction == DWARVES) {
            front += tiles;
        } else {
            front -= tiles;
        }

        deadline = uint64(_min(uint256(deadline) + EXTEND, block.timestamp + MAX_CLOCK));

        emit Pushed(msg.sender, faction, tiles, front, msg.value);

        if (front >= TOTAL_TILES) {
            front = TOTAL_TILES;
            _resolve(DWARVES, true);
        } else if (front == 0) {
            _resolve(ORCS, true);
        }
    }

    function resolve() external {
        require(phase == Phase.ACTIVE, "NOT_ACTIVE");
        require(block.timestamp >= deadline, "DEADLINE_NOT_REACHED");

        uint8 winningFaction = front >= MIDLINE ? DWARVES : ORCS;
        _resolve(winningFaction, false);
    }

    function claim() external nonReentrant {
        _claimRound(currentRound);
    }

    function claimRound(uint256 roundId) external nonReentrant {
        _claimRound(roundId);
    }

    function _claimRound(uint256 roundId) private {
        RoundResolution memory result = roundResolution[roundId];
        require(result.resolved, "ROUND_NOT_RESOLVED");
        require(result.totalWinnerContrib > 0, "NO_WINNER_CONTRIB");

        uint256 contribution = _contrib[roundId][msg.sender][result.winner];
        require(contribution > 0, "NO_WINNING_CONTRIBUTION");

        _contrib[roundId][msg.sender][result.winner] = 0;
        uint256 share = (result.payoutPool * contribution) / result.totalWinnerContrib;

        (bool ok,) = msg.sender.call{ value: share }("");
        require(ok, "CLAIM_FAILED");

        emit Claimed(msg.sender, share);
    }

    function startNewRound() external {
        require(phase == Phase.RESOLVED, "NOT_RESOLVED");

        uint256 rolloverBonus = winnerHit70 ? 0 : bonusPool;
        currentRound += 1;
        front = START;
        jackpot = 0;
        bonusPool = rolloverBonus;
        deadline = uint64(block.timestamp + INITIAL_CLOCK);
        phase = Phase.ACTIVE;
        winner = NO_WINNER;
        winnerHit70 = false;

        emit NewRound(currentRound, rolloverBonus, deadline);
    }

    function withdrawTreasury(address payable to) external onlyOwner nonReentrant {
        address payable recipient = to == address(0) ? payable(treasury) : to;
        require(recipient != address(0), "BAD_RECIPIENT");

        uint256 amount = treasuryCredit;
        require(amount > 0, "NO_TREASURY_CREDIT");
        treasuryCredit = 0;

        (bool ok,) = recipient.call{ value: amount }("");
        require(ok, "TREASURY_WITHDRAW_FAILED");

        emit TreasuryWithdrawn(recipient, amount);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "BAD_TREASURY");
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "BAD_OWNER");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function pricePerTile(uint8 faction) external view returns (uint256 wei_) {
        _validateFaction(faction);
        uint256 remaining = faction == DWARVES ? TOTAL_TILES - front : front;
        if (remaining == 0) {
            return 0;
        }
        return _tilePrice(faction, front);
    }

    function quote(uint8 faction, uint256 valueWei)
        public
        view
        returns (uint256 tiles, uint256 cost)
    {
        _validateFaction(faction);
        uint256 remaining = faction == DWARVES ? TOTAL_TILES - front : front;
        uint256 low = 0;
        uint256 high = remaining;

        while (low < high) {
            uint256 mid = (low + high + 1) / 2;
            uint256 midCost = _costForTiles(faction, mid);
            if (midCost <= valueWei) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }

        tiles = low;
        cost = _costForTiles(faction, tiles);
    }

    function costForTiles(uint8 faction, uint256 tiles) external view returns (uint256 cost) {
        _validateFaction(faction);
        uint256 remaining = faction == DWARVES ? TOTAL_TILES - front : front;
        require(tiles <= remaining, "TOO_MANY_TILES");
        return _costForTiles(faction, tiles);
    }

    function gameState()
        external
        view
        returns (
            uint256 front_,
            uint256 jackpot_,
            uint256 bonusPool_,
            uint64 deadline_,
            Phase phase_,
            uint8 winner_
        )
    {
        return (front, jackpot, bonusPool, deadline, phase, winner);
    }

    function contributionOf(address who, uint8 faction) external view returns (uint256) {
        _validateFaction(faction);
        return _contrib[currentRound][who][faction];
    }

    function contributionOfRound(uint256 roundId, address who, uint8 faction)
        external
        view
        returns (uint256)
    {
        _validateFaction(faction);
        return _contrib[roundId][who][faction];
    }

    function _resolve(uint8 winningFaction, bool suddenDeath) private {
        require(phase == Phase.ACTIVE, "NOT_ACTIVE");

        bool bonusAwarded = suddenDeath || _hitBonusThreshold(winningFaction);
        uint256 payoutPool = jackpot + (bonusAwarded ? bonusPool : 0);
        uint256 winnerContrib = totalContrib[currentRound][winningFaction];

        phase = Phase.RESOLVED;
        winner = winningFaction;
        winnerHit70 = bonusAwarded;
        roundResolution[currentRound] = RoundResolution({
            winner: winningFaction,
            bonusAwarded: bonusAwarded,
            resolved: true,
            payoutPool: payoutPool,
            totalWinnerContrib: winnerContrib
        });

        emit Resolved(winningFaction, jackpot, bonusAwarded);
    }

    function _hitBonusThreshold(uint8 faction) private view returns (bool) {
        if (faction == DWARVES) {
            return front >= BONUS_THRESHOLD;
        }
        return front <= TOTAL_TILES - BONUS_THRESHOLD;
    }

    function _costForTiles(uint8 faction, uint256 tiles) private view returns (uint256) {
        if (tiles == 0) {
            return 0;
        }

        uint256 depthSum = faction == DWARVES
            ? _dwarfDepthSum(front, tiles)
            : _orcDepthSum(front, tiles);

        return (BASE_COST * tiles) + (ESCALATION_COST_PER_DEPTH * depthSum);
    }

    function _dwarfDepthSum(uint256 startX, uint256 tiles) private view returns (uint256) {
        uint256 endX = startX + tiles - 1;
        if (endX <= MIDLINE) {
            return 0;
        }

        uint256 first = startX > MIDLINE ? startX : MIDLINE + 1;
        uint256 count = endX - first + 1;
        uint256 firstDepth = first - MIDLINE;
        uint256 lastDepth = endX - MIDLINE;
        return (count * (firstDepth + lastDepth)) / 2;
    }

    function _orcDepthSum(uint256 startX, uint256 tiles) private view returns (uint256) {
        uint256 lowX = startX - tiles + 1;
        if (lowX >= MIDLINE) {
            return 0;
        }

        uint256 last = startX < MIDLINE ? startX : MIDLINE - 1;
        uint256 count = last - lowX + 1;
        uint256 firstDepth = MIDLINE - lowX;
        uint256 lastDepth = MIDLINE - last;
        return (count * (firstDepth + lastDepth)) / 2;
    }

    function _tilePrice(uint8 faction, uint256 x) private view returns (uint256) {
        uint256 depth = faction == DWARVES
            ? (x > MIDLINE ? x - MIDLINE : 0)
            : (x < MIDLINE ? MIDLINE - x : 0);
        return BASE_COST + (ESCALATION_COST_PER_DEPTH * depth);
    }

    function _validateFaction(uint8 faction) private pure {
        require(faction == DWARVES || faction == ORCS, "BAD_FACTION");
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
