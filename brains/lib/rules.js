// The rules a brain may use — the one door from brains into the game.
//
// Everything a brain needs to price, count and cap goes through here, never
// straight from game.js or bots.js. Today it re-exports the game's own
// functions; when the bot brains leave this repo it becomes a small package
// (or its numbers travel in view.rules), and the brains do not change.
export {
  unitPower, PROTECTED_POINTS, RESOURCES, UNITS, QUEUE_MAX, TRAIN_QUEUE_MAX,
  pendingLevel, upgradeCost, canAfford, storageCapacity, popUsed, popCap, islandPoints, trainCostAt,
} from '../../game.js';
export { MAX_BOT_ISLANDS, TUNING, garrisonCap } from '../../bots.js';
