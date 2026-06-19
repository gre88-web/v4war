// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { SiegeOfTheCrown } from "../src/SiegeOfTheCrown.sol";

interface Vm {
    function warp(uint256 timestamp) external;
    function deal(address who, uint256 newBalance) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function expectRevert(bytes calldata revertData) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 actual, uint256 expected, string memory label) internal pure {
        require(actual == expected, label);
    }

    function assertEq(address actual, address expected, string memory label) internal pure {
        require(actual == expected, label);
    }

    function assertTrue(bool condition, string memory label) internal pure {
        require(condition, label);
    }

    function assertFalse(bool condition, string memory label) internal pure {
        require(!condition, label);
    }
}

contract SiegeOfTheCrownTest is TestBase {
    uint256 internal constant TOTAL_TILES = 10_000;
    uint256 internal constant START = 5_000;
    uint256 internal constant BASE_COST = 0.0005 ether;
    uint256 internal constant ESCALATION = 9;
    uint256 internal constant ESCALATION_UNIT = (BASE_COST * ESCALATION) / START;
    uint16 internal constant FEE_BPS = 300;
    uint16 internal constant BONUS_BPS = 1_000;
    uint64 internal constant INITIAL_CLOCK = 24 hours;
    uint64 internal constant EXTEND = 30 seconds;
    uint64 internal constant MAX_CLOCK = 6 hours;

    address internal treasury = address(0xA11CE);
    address internal alice = address(0xBEEF);
    address internal bob = address(0xCAFE);
    address internal carol = address(0xD00D);

    SiegeOfTheCrown internal game;

    function setUp() public {
        vm.warp(1_000);
        game = new SiegeOfTheCrown(_config());
    }

    function testInitialStateAndMidlinePricing() public view {
        (
            uint256 front,
            uint256 jackpot,
            uint256 bonusPool,
            uint64 deadline,
            SiegeOfTheCrown.Phase phase,
            uint8 winner
        ) = game.gameState();

        assertEq(front, START, "front");
        assertEq(jackpot, 0, "jackpot");
        assertEq(bonusPool, 0, "bonus");
        assertEq(deadline, block.timestamp + INITIAL_CLOCK, "deadline");
        assertEq(uint256(phase), uint256(SiegeOfTheCrown.Phase.ACTIVE), "phase");
        assertEq(uint256(winner), uint256(game.NO_WINNER()), "winner");
        assertEq(game.pricePerTile(game.DWARVES()), BASE_COST, "dwarf midline price");
        assertEq(game.pricePerTile(game.ORCS()), BASE_COST, "orc midline price");
    }

    function testQuoteUsesArithmeticSeriesAndRejectsDust() public {
        uint256 expectedCost = (BASE_COST * 3) + (ESCALATION_UNIT * (0 + 1 + 2));

        (uint256 tiles, uint256 cost) = game.quote(game.DWARVES(), expectedCost);
        assertEq(tiles, 3, "tiles");
        assertEq(cost, expectedCost, "cost");

        (tiles, cost) = game.quote(game.DWARVES(), expectedCost + 1);
        assertEq(tiles, 3, "dust tiles");
        assertEq(cost, expectedCost, "dust cost");

        vm.deal(alice, expectedCost + 1);
        vm.prank(alice);
        vm.expectRevert(bytes("INEXACT_PAYMENT"));
        game.push{ value: expectedCost + 1 }(0);
    }

    function testEscalationAndRubberBandPricing() public {
        _pushTiles(alice, game.DWARVES(), 2_000);

        assertEq(game.front(), 7_000, "front after push");
        assertEq(
            game.pricePerTile(game.DWARVES()),
            BASE_COST + (ESCALATION_UNIT * 2_000),
            "leader deep push price"
        );
        assertEq(game.pricePerTile(game.ORCS()), BASE_COST, "losing counter-push price");
    }

    function testMoneyFlowTracksFeeBonusJackpotAndNetContribution() public {
        uint256 cost = game.costForTiles(game.DWARVES(), 1);
        uint256 fee = (cost * FEE_BPS) / 10_000;
        uint256 net = cost - fee;
        uint256 bonusCut = (net * BONUS_BPS) / 10_000;

        _pushExact(alice, game.DWARVES(), cost);

        assertEq(game.treasuryCredit(), fee, "fee");
        assertEq(game.bonusPool(), bonusCut, "bonus cut");
        assertEq(game.jackpot(), net - bonusCut, "jackpot cut");
        assertEq(game.contributionOf(alice, game.DWARVES()), net, "contribution");
        assertEq(game.totalContrib(0, game.DWARVES()), net, "total contribution");
    }

    function testSuddenDeathDwarvesAwardsWholeBonusPool() public {
        uint256 cost = game.costForTiles(game.DWARVES(), 5_000);
        _pushExact(alice, game.DWARVES(), cost);

        assertEq(game.front(), TOTAL_TILES, "front");
        assertEq(uint256(game.phase()), uint256(SiegeOfTheCrown.Phase.RESOLVED), "phase");
        assertEq(game.winner(), game.DWARVES(), "winner");
        assertTrue(game.winnerHit70(), "bonus awarded");

        (,,, uint256 payoutPool,) = game.roundResolution(0);
        assertEq(payoutPool, game.jackpot() + game.bonusPool(), "payout includes bonus");
    }

    function testSuddenDeathOrcsAwardsWholeBonusPool() public {
        uint256 cost = game.costForTiles(game.ORCS(), 5_000);
        _pushExact(alice, game.ORCS(), cost);

        assertEq(game.front(), 0, "front");
        assertEq(uint256(game.phase()), uint256(SiegeOfTheCrown.Phase.RESOLVED), "phase");
        assertEq(game.winner(), game.ORCS(), "winner");
        assertTrue(game.winnerHit70(), "bonus awarded");
    }

    function testTimerExtensionUsesMaxClockCapThenExtendsNormally() public {
        uint256 firstCost = game.costForTiles(game.DWARVES(), 1);
        _pushExact(alice, game.DWARVES(), firstCost);

        assertEq(game.deadline(), uint64(block.timestamp + MAX_CLOCK), "initial cap");

        vm.warp(game.deadline() - 10 seconds);
        uint256 secondCost = game.costForTiles(game.ORCS(), 1);
        uint64 previousDeadline = game.deadline();
        _pushExact(bob, game.ORCS(), secondCost);

        assertEq(game.deadline(), previousDeadline + EXTEND, "normal extension");
    }

    function testTimerExpiryResolvesByTileLeader() public {
        _pushTiles(alice, game.DWARVES(), 2);
        vm.warp(game.deadline());

        game.resolve();

        assertEq(uint256(game.phase()), uint256(SiegeOfTheCrown.Phase.RESOLVED), "phase");
        assertEq(game.winner(), game.DWARVES(), "winner");
        assertFalse(game.winnerHit70(), "no 70 percent bonus");
    }

    function testSeventyPercentBonusAwardedOnTimerResolution() public {
        _pushTiles(alice, game.DWARVES(), 2_000);
        uint256 payout = game.jackpot() + game.bonusPool();

        vm.warp(game.deadline());
        game.resolve();

        assertTrue(game.winnerHit70(), "bonus awarded");
        (,,, uint256 payoutPool,) = game.roundResolution(0);
        assertEq(payoutPool, payout, "payout");
    }

    function testBonusRollsOverWhenWinnerBelowSeventyPercent() public {
        _pushTiles(alice, game.DWARVES(), 1);
        uint256 rollover = game.bonusPool();

        vm.warp(game.deadline());
        game.resolve();
        assertFalse(game.winnerHit70(), "bonus not awarded");

        game.startNewRound();

        assertEq(game.currentRound(), 1, "round");
        assertEq(game.front(), START, "front reset");
        assertEq(game.jackpot(), 0, "jackpot reset");
        assertEq(game.bonusPool(), rollover, "bonus rollover");
        assertEq(uint256(game.phase()), uint256(SiegeOfTheCrown.Phase.ACTIVE), "phase reset");
    }

    function testProRataPullPayoutsAndLoserGetsNothing() public {
        uint256 aliceCost = game.costForTiles(game.DWARVES(), 1);
        _pushExact(alice, game.DWARVES(), aliceCost);

        uint256 bobCost = game.costForTiles(game.DWARVES(), 2);
        _pushExact(bob, game.DWARVES(), bobCost);

        uint256 carolCost = game.costForTiles(game.ORCS(), 1);
        _pushExact(carol, game.ORCS(), carolCost);

        uint256 aliceContribution = _net(aliceCost);
        uint256 bobContribution = _net(bobCost);
        uint256 totalWinnerContribution = aliceContribution + bobContribution;
        uint256 payoutPool = game.jackpot();

        vm.warp(game.deadline());
        game.resolve();

        uint256 expectedAliceShare = (payoutPool * aliceContribution) / totalWinnerContribution;
        uint256 expectedBobShare = (payoutPool * bobContribution) / totalWinnerContribution;

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        game.claim();
        assertEq(alice.balance - aliceBefore, expectedAliceShare, "alice share");
        assertEq(game.contributionOf(alice, game.DWARVES()), 0, "alice contribution zeroed");

        uint256 bobBefore = bob.balance;
        vm.prank(bob);
        game.claim();
        assertEq(bob.balance - bobBefore, expectedBobShare, "bob share");

        vm.prank(carol);
        vm.expectRevert(bytes("NO_WINNING_CONTRIBUTION"));
        game.claim();
    }

    function testClaimRoundStillWorksAfterNewRoundStarts() public {
        _pushTiles(alice, game.DWARVES(), 1);
        uint256 expected = game.jackpot();

        vm.warp(game.deadline());
        game.resolve();
        game.startNewRound();

        uint256 beforeBalance = alice.balance;
        vm.prank(alice);
        game.claimRound(0);

        assertEq(alice.balance - beforeBalance, expected, "old round claim");
    }

    function testReentrancyAttemptCannotDoubleClaim() public {
        ReenteringWinner attacker = new ReenteringWinner(game);
        uint256 cost = game.costForTiles(game.DWARVES(), 1);
        vm.deal(address(attacker), cost);
        attacker.pushDwarves(cost);

        uint256 expected = game.jackpot();
        vm.warp(game.deadline());
        game.resolve();

        attacker.claim();

        assertEq(address(attacker).balance, expected, "paid once");
        assertEq(attacker.reentryAttempts(), 1, "attempted reentry");
        assertEq(game.contributionOf(address(attacker), game.DWARVES()), 0, "zeroed");
    }

    function testPhasePauseInvalidFactionAndDeadlineGuards() public {
        vm.expectRevert(bytes("BAD_FACTION"));
        game.pricePerTile(2);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(bytes("NO_TILES"));
        game.push{ value: 1 }(0);

        game.setPaused(true);
        uint256 cost = game.costForTiles(game.DWARVES(), 1);
        vm.deal(alice, cost);
        vm.prank(alice);
        vm.expectRevert(bytes("PAUSED"));
        game.push{ value: cost }(0);
        game.setPaused(false);

        vm.warp(game.deadline());
        vm.deal(alice, cost);
        vm.prank(alice);
        vm.expectRevert(bytes("CURSE_EXPIRED"));
        game.push{ value: cost }(0);

        game.resolve();
        vm.expectRevert(bytes("NOT_ACTIVE"));
        game.resolve();
    }

    function testTreasuryWithdrawalIsOwnerOnlyPullPayment() public {
        uint256 cost = game.costForTiles(game.DWARVES(), 1);
        _pushExact(alice, game.DWARVES(), cost);
        uint256 fee = (cost * FEE_BPS) / 10_000;

        vm.prank(alice);
        vm.expectRevert(bytes("ONLY_OWNER"));
        game.withdrawTreasury(payable(alice));

        uint256 beforeBalance = treasury.balance;
        game.withdrawTreasury(payable(address(0)));

        assertEq(treasury.balance - beforeBalance, fee, "treasury fee");
        assertEq(game.treasuryCredit(), 0, "credit zeroed");
    }

    function _config() internal view returns (SiegeOfTheCrown.Config memory) {
        return SiegeOfTheCrown.Config({
            treasury: treasury,
            totalTiles: TOTAL_TILES,
            start: START,
            baseCost: BASE_COST,
            escalation: ESCALATION,
            feeBps: FEE_BPS,
            bonusBps: BONUS_BPS,
            initialClock: INITIAL_CLOCK,
            extend: EXTEND,
            maxClock: MAX_CLOCK
        });
    }

    function _pushTiles(address player, uint8 faction, uint256 tiles) internal {
        uint256 cost = game.costForTiles(faction, tiles);
        _pushExact(player, faction, cost);
    }

    function _pushExact(address player, uint8 faction, uint256 cost) internal {
        vm.deal(player, cost);
        vm.prank(player);
        game.push{ value: cost }(faction);
    }

    function _net(uint256 cost) internal pure returns (uint256) {
        return cost - ((cost * FEE_BPS) / 10_000);
    }
}

contract ReenteringWinner {
    SiegeOfTheCrown internal immutable game;
    uint256 public reentryAttempts;

    constructor(SiegeOfTheCrown game_) {
        game = game_;
    }

    function pushDwarves(uint256 cost) external {
        game.push{ value: cost }(game.DWARVES());
    }

    function claim() external {
        game.claim();
    }

    receive() external payable {
        if (reentryAttempts == 0) {
            reentryAttempts = 1;
            try game.claim() { } catch { }
        }
    }
}
