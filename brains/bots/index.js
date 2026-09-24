// Every bot's own brain, one file each, keyed by the bot's name. A brain
// here is built in (no time budget) but thinks for nobody until a persona
// names it — BOT_BRAIN_OF="Coral Kate=coral-kate". These may later move to
// their own repo; they reach the game only through ../lib.
import * as barnacle_bill from './barnacle-bill.js';
import * as coral_kate from './coral-kate.js';
import * as driftwood_dan from './driftwood-dan.js';
import * as kelpie from './kelpie.js';
import * as old_wrack from './old-wrack.js';
import * as pearl_diver from './pearl-diver.js';
import * as reef_rat from './reef-rat.js';
import * as saltmarsh_sam from './saltmarsh-sam.js';
import * as skerry_jack from './skerry-jack.js';
import * as tide_turner from './tide-turner.js';
import * as gull_cry from './gull-cry.js';
import * as mangrove_mo from './mangrove-mo.js';
import * as nautilus_ned from './nautilus-ned.js';
import * as osprey from './osprey.js';
import * as puffin_pete from './puffin-pete.js';
import * as quayside_quinn from './quayside-quinn.js';
import * as rockpool_rosa from './rockpool-rosa.js';
import * as seagrass_sue from './seagrass-sue.js';
import * as trawler_tom from './trawler-tom.js';
import * as undertow from './undertow.js';
import * as vela_the_vast from './vela-the-vast.js';
import * as wavebreaker from './wavebreaker.js';
import * as foamborn_finn from './foamborn-finn.js';
import * as lagoon_lena from './lagoon-lena.js';

export const BOT_BRAINS = Object.freeze({
  "Barnacle Bill": barnacle_bill,
  "Coral Kate": coral_kate,
  "Driftwood Dan": driftwood_dan,
  "Kelpie": kelpie,
  "Old Wrack": old_wrack,
  "Pearl Diver": pearl_diver,
  "Reef Rat": reef_rat,
  "Saltmarsh Sam": saltmarsh_sam,
  "Skerry Jack": skerry_jack,
  "Tide Turner": tide_turner,
  "Gull Cry": gull_cry,
  "Mangrove Mo": mangrove_mo,
  "Nautilus Ned": nautilus_ned,
  "Osprey": osprey,
  "Puffin Pete": puffin_pete,
  "Quayside Quinn": quayside_quinn,
  "Rockpool Rosa": rockpool_rosa,
  "Seagrass Sue": seagrass_sue,
  "Trawler Tom": trawler_tom,
  "Undertow": undertow,
  "Vela the Vast": vela_the_vast,
  "Wavebreaker": wavebreaker,
  "Foamborn Finn": foamborn_finn,
  "Lagoon Lena": lagoon_lena,
});
