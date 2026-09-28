import { createClient } from "@libsql/client";
import dotenv from "dotenv";
import { canonicalEpisodeScriptJson, SeriesState } from "../src/state/seriesState.js";
import { buildEpisodeTtsTool } from "../src/tools/ttsTool.js";
import { ensureAgnesKeyArtAudioAssets } from "../src/services/agnesKeyArtService.js";
import { inspectProductionScript } from "../src/services/productionScriptContract.js";
import { CONFIG } from "../src/config.js";
import { rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export const TIME_TRAVEL_EPISODE_1_SCRIPT = {
  title: "Back to the Dino Jungle",
  scenes: [
    {
      sceneNumber: 1,
      narrationText: "Mia, Leo, and Tara gathered around an old wooden chest in the sunlit attic.",
      environmentDescription: "A warm wooden attic with sunbeams streaming through round dormer windows onto pine floorboards.",
      action: "Mia lifts the wooden chest lid while Leo and Tara peer eagerly inside.",
      characterNames: ["Mia", "Leo", "Tara"],
      supportingEntities: [],
      continuityAnchors: ["Wooden chest: weathered cedar chest open on the attic floor"],
      sceneDetails: "The children kneel closely together around the chest in warm golden light.",
      cameraAngle: "child-height medium shot",
      lighting: "warm dusty morning sunbeams",
    },
    {
      sceneNumber: 2,
      narrationText: "Inside rested Bobo, a bright blue backpack with stitched smile and lively button eyes.",
      environmentDescription: "Inside the open cedar chest surrounded by antique toys and colorful quilts.",
      action: "Bobo the Backpack stretches small blue arms, blinks button eyes, and giggles softly.",
      characterNames: ["Bobo the Backpack", "Mia"],
      supportingEntities: [],
      continuityAnchors: ["Cedar chest: antique wooden chest interior with quilted cloth"],
      sceneDetails: "Bobo sits up straight in the center of the chest facing Mia.",
      cameraAngle: "close-up shot",
      lighting: "soft golden morning light",
    },
    {
      sceneNumber: 3,
      narrationText: "Leo cheered: 'Look at him dance!' as Bobo gave an energetic little wiggle.",
      environmentDescription: "The sunlit attic floor beside stacked vintage books and model airplanes.",
      action: "Leo claps his hands cheerfully while Bobo wiggles his yellow straps and hops.",
      characterNames: ["Leo", "Bobo the Backpack"],
      supportingEntities: [],
      continuityAnchors: ["Attic rug: braided wool rug resting on wide pine planks"],
      sceneDetails: "Leo crouches on the left while Bobo bounces happily in the middle.",
      cameraAngle: "medium wide shot",
      lighting: "bright cheerful attic daylight",
    },
    {
      sceneNumber: 4,
      narrationText: "Tara spotted a gleaming brass key dangling from Bobo's side pocket with curiosity.",
      environmentDescription: "The cozy attic floor near a round dusty window and wooden easel.",
      action: "Tara points her finger toward the brass key resting on Bobo's side pocket.",
      characterNames: ["Tara", "Bobo the Backpack"],
      supportingEntities: [],
      continuityAnchors: ["Brass key: ornate antique key hanging from a yellow strap"],
      sceneDetails: "Tara observes carefully from the right side while Bobo steadies his straps.",
      cameraAngle: "medium shot",
      lighting: "soft directional morning light",
    },
    {
      sceneNumber: 5,
      narrationText: "Bobo sneezed three times, unzipping a swirling golden portal of dancing warm sparkles.",
      environmentDescription: "The center of the attic floor beneath exposed dark-wood roof rafters.",
      action: "Bobo sneezes and unzips, casting a round golden glowing portal across the attic.",
      characterNames: ["Bobo the Backpack", "Mia", "Leo", "Tara"],
      supportingEntities: [],
      continuityAnchors: ["Golden portal: vertical swirling circle of shimmering warm amber light"],
      sceneDetails: "Bobo sits before the glowing portal while the three children look on in awe.",
      cameraAngle: "wide establishing shot",
      lighting: "dramatic warm amber portal glow illuminating dark attic beams",
    },
    {
      sceneNumber: 6,
      narrationText: "Mia held her brown notebook tightly as they stepped through the shimmering doorway together.",
      environmentDescription: "Directly in front of the swirling golden portal on the attic floor.",
      action: "Mia clutches her brown notebook and leads the children through the golden portal.",
      characterNames: ["Mia", "Leo", "Tara"],
      supportingEntities: [],
      continuityAnchors: ["Brown notebook: classic leather-bound notebook held in Mia's hand"],
      sceneDetails: "The children step forward hand-in-hand into the warm golden light.",
      cameraAngle: "medium shot from behind",
      lighting: "bright radiant amber glow",
    },
    {
      sceneNumber: 7,
      narrationText: "Warm humid air greeted them beside towering green ferns and prehistoric giant palm trees.",
      environmentDescription: "A lush prehistoric jungle with giant broad-leaved ferns and mossy tree trunks.",
      action: "Leo gazes up in wonder at massive leafy ferns under a bright tropical sky.",
      characterNames: ["Leo", "Tara"],
      supportingEntities: [],
      continuityAnchors: ["Giant ferns: towering green fronds arching over a dirt path"],
      sceneDetails: "Leo and Tara stand on a damp earthen trail looking up at towering flora.",
      cameraAngle: "low-angle wide shot",
      lighting: "vibrant tropical morning sunshine",
    },
    {
      sceneNumber: 8,
      narrationText: "Tara listened closely to a soft, chirping peep echoing beyond the thick prehistoric bushes.",
      environmentDescription: "A jungle clearing bordered by flowering prehistoric cycads and flowering vines.",
      action: "Tara cups her hand to her ear, leaning toward flowering tropical bushes.",
      characterNames: ["Tara", "Mia"],
      supportingEntities: [],
      continuityAnchors: ["Cycad bushes: thick cluster of serrated prehistoric green leaves"],
      sceneDetails: "Tara pauses attentively while Mia watches beside her.",
      cameraAngle: "medium close-up shot",
      lighting: "dappled sunlight filtering through broad canopy leaves",
    },
    {
      sceneNumber: 9,
      narrationText: "A tiny seafoam-green baby triceratops peeked through huge broad leaves, blinking gentle brown eyes.",
      environmentDescription: "A low natural leafy hollow beneath giant prehistoric fronds.",
      action: "Trixie the Triceratops peeks out from large leaves, looking shy and gentle.",
      characterNames: ["Mia", "Bobo the Backpack"],
      supportingEntities: ["Trixie the Triceratops: tiny gentle baby triceratops with seafoam-green scales and three rounded horn buds"],
      continuityAnchors: ["Leafy hollow: cluster of emerald fronds sheltering damp soil"],
      sceneDetails: "Trixie emerges timidly with soft curious expression.",
      cameraAngle: "child-height close shot",
      lighting: "soft diffused jungle green daylight",
    },
    {
      sceneNumber: 10,
      narrationText: "Mia smiled gently: 'Hello, little Trixie!' as the baby dinosaur gave a friendly chirp.",
      environmentDescription: "The edge of the leafy hollow beside a patch of soft clover-like moss.",
      action: "Mia crouches down at eye level, offering a welcoming wave to Trixie.",
      characterNames: ["Mia"],
      supportingEntities: ["Trixie the Triceratops: tiny gentle baby triceratops with seafoam-green scales and three rounded horn buds"],
      continuityAnchors: ["Moss patch: bright velvety green moss carpet on the trail"],
      sceneDetails: "Mia smiles warmly at the baby triceratops resting two feet away.",
      cameraAngle: "medium two-shot",
      lighting: "warm welcoming morning sunlight",
    },
    {
      sceneNumber: 11,
      narrationText: "Leo noticed three large footprints leading away through the damp muddy valley trail.",
      environmentDescription: "A moist mud path winding through towering horsetail reeds.",
      action: "Leo kneels beside a huge three-toed footprint pressed into the damp soil path.",
      characterNames: ["Leo", "Tara"],
      supportingEntities: [],
      continuityAnchors: ["Dino footprint: deep three-toed depression in dark damp soil"],
      sceneDetails: "Leo points into the imprint while Tara inspects the mud edge.",
      cameraAngle: "medium shot looking down",
      lighting: "clear tropical daylight reflecting in muddy puddle edges",
    },
    {
      sceneNumber: 12,
      narrationText: "Tara checked the pattern: 'Her family walked toward the sparkling blue jungle river!'",
      environmentDescription: "A slight jungle ridge overlooking a distant shimmering river valley.",
      action: "Tara traces the footprint rim with her finger and points toward the distant river.",
      characterNames: ["Tara", "Leo"],
      supportingEntities: [],
      continuityAnchors: ["Valley overlook: elevated earthen ridge framed by tall palm trees"],
      sceneDetails: "Tara stands on the crest gesturing toward the bright river ahead.",
      cameraAngle: "medium wide establishing shot",
      lighting: "bright scenic tropical sunlight",
    },
    {
      sceneNumber: 13,
      narrationText: "Bobo hopped forward, gently popping out a colorful map compass from his zipper.",
      environmentDescription: "The jungle trail crest under arching flowering vine canopies.",
      action: "Bobo the Backpack wiggles and produces a shiny brass compass from his front pocket.",
      characterNames: ["Bobo the Backpack", "Mia"],
      supportingEntities: [],
      continuityAnchors: ["Map compass: round brass navigational compass with glowing needle"],
      sceneDetails: "Bobo holds the compass outward proudly while Mia smiles in appreciation.",
      cameraAngle: "medium close-up",
      lighting: "warm sunlit gleam on brass compass",
    },
    {
      sceneNumber: 14,
      narrationText: "Together the friends marched along the fern path, following the steady giant dinosaur tracks.",
      environmentDescription: "A wide sloping path flanked by giant prehistoric ferns and purple jungle flowers.",
      action: "Leo and Mia walk side by side while Trixie trots happily between them.",
      characterNames: ["Leo", "Mia"],
      supportingEntities: ["Trixie the Triceratops: tiny gentle baby triceratops with seafoam-green scales and three rounded horn buds"],
      continuityAnchors: ["Fern path: red earthen trail bordered by purple prehistoric flowers"],
      sceneDetails: "The cheerful group moves forward with rhythmic teamwork and curiosity.",
      cameraAngle: "medium tracking shot",
      lighting: "sunny tropical daylight with soft foliage shadows",
    },
    {
      sceneNumber: 15,
      narrationText: "A giant mossy fallen tree trunk blocked the path ahead near tall cycad trees.",
      environmentDescription: "A narrow valley crossing blocked by a huge ancient fallen sequoia trunk.",
      action: "Leo stops before a massive moss-covered log lying across the jungle trail.",
      characterNames: ["Leo", "Tara"],
      supportingEntities: [],
      continuityAnchors: ["Fallen tree trunk: thick ancient log covered in emerald moss and shelf mushrooms"],
      sceneDetails: "Leo looks up at the waist-high log considering how to help Trixie across.",
      cameraAngle: "medium wide shot",
      lighting: "dappled sunlight filtering through cycad canopy",
    },
    {
      sceneNumber: 16,
      narrationText: "Bobo puffed out his soft straps, creating a gentle stepping cushion for little Trixie.",
      environmentDescription: "The base of the mossy fallen log on the forest path.",
      action: "Bobo lowers his padded yellow straps to form a soft bridge over the log.",
      characterNames: ["Bobo the Backpack"],
      supportingEntities: ["Trixie the Triceratops: tiny gentle baby triceratops with seafoam-green scales and three rounded horn buds"],
      continuityAnchors: ["Fallen tree trunk: thick mossy log with Bobo anchored against it"],
      sceneDetails: "Bobo braces sturdily against the log giving Trixie a secure foothold.",
      cameraAngle: "close action shot",
      lighting: "soft natural forest daylight",
    },
    {
      sceneNumber: 17,
      narrationText: "Trixie gave a joyful hop across, landing safely on the soft green moss below.",
      environmentDescription: "The far side of the fallen log bordered by soft velvet moss.",
      action: "Trixie hops over the log and lands happily on moss beside Tara.",
      characterNames: ["Tara"],
      supportingEntities: ["Trixie the Triceratops: tiny gentle baby triceratops with seafoam-green scales and three rounded horn buds"],
      continuityAnchors: ["Velvet moss: thick springy moss carpet on the trail's far side"],
      sceneDetails: "Tara reaches out encouragingly as Trixie shakes her tail with relief.",
      cameraAngle: "medium shot",
      lighting: "warm afternoon sunbeams",
    },
    {
      sceneNumber: 18,
      narrationText: "Sunlight sparkled across the wide riverbank, where tall golden grasses rustled in the breeze.",
      environmentDescription: "A broad sandy riverbank edged with tall golden reeds and clear flowing water.",
      action: "Mia and Tara reach the sunny riverbank overlooking clear rippling blue water.",
      characterNames: ["Mia", "Tara"],
      supportingEntities: [],
      continuityAnchors: ["Sandy riverbank: smooth pale sand meeting clear blue river currents"],
      sceneDetails: "Mia and Tara stand side-by-side enjoying the open breeze across the water.",
      cameraAngle: "wide scenic shot",
      lighting: "bright sparkling river sunlight",
    },
    {
      sceneNumber: 19,
      narrationText: "A deep, friendly rumble echoed across the shore as leafy bushes gently parted ahead.",
      environmentDescription: "The lush edge of the riverbank where giant willow-like prehistoric trees grow.",
      action: "Leo points excitedly toward a clearing across the shallow sandy bend.",
      characterNames: ["Leo", "Bobo the Backpack"],
      supportingEntities: [],
      continuityAnchors: ["Riverbend clearing: shallow sunlit sandbar surrounded by tall palms"],
      sceneDetails: "Leo shields his eyes to see who is calling across the riverbank.",
      cameraAngle: "medium wide shot",
      lighting: "golden late-afternoon sunshine",
    },
    {
      sceneNumber: 20,
      narrationText: "A majestic mother triceratops stepped forward, nuzzling little Trixie with warm, joyful affection.",
      environmentDescription: "The wide sunlit sandbar at the river bend.",
      action: "A large green mother triceratops lowers her snout to gently nuzzle Trixie on the sand.",
      characterNames: ["Mia", "Leo"],
      supportingEntities: [
        "Mother Triceratops: large gentle triceratops with moss-green scales and three smooth ivory horns",
        "Trixie the Triceratops: tiny gentle baby triceratops with seafoam-green scales and three rounded horn buds"
      ],
      continuityAnchors: ["Riverbend clearing: open pale sandbar with clear sparkling water"],
      sceneDetails: "The mother and baby nuzzle lovingly while Mia and Leo watch happily.",
      cameraAngle: "wide heartwarming shot",
      lighting: "warm golden sunset glow",
    },
    {
      sceneNumber: 21,
      narrationText: "Trixie turned and rubbed her snout against Bobo, chirping one final happy goodbye.",
      environmentDescription: "The riverbank path under gentle amber evening twilight.",
      action: "Trixie rubs against Bobo's blue fabric while the children wave happily.",
      characterNames: ["Bobo the Backpack", "Mia", "Leo", "Tara"],
      supportingEntities: ["Trixie the Triceratops: tiny gentle baby triceratops with seafoam-green scales and three rounded horn buds"],
      continuityAnchors: ["Riverbank path: smooth packed sand under early evening twilight"],
      sceneDetails: "Bobo giggles and wiggles his straps in delight at Trixie's gentle nuzzle.",
      cameraAngle: "medium group shot",
      lighting: "warm amber dusk with violet shadows",
    },
    {
      sceneNumber: 22,
      narrationText: "Bobo's button eyes sparkled brightly as he opened the swirling golden home portal again.",
      environmentDescription: "The quiet riverbank meadow as the first evening stars appear.",
      action: "Bobo spins joyfully in a circle, opening the golden glowing doorway back home.",
      characterNames: ["Bobo the Backpack", "Leo"],
      supportingEntities: [],
      continuityAnchors: ["Golden portal: vertical swirling doorway of warm amber light"],
      sceneDetails: "The portal illuminates Leo and Bobo against the darkening prehistoric sky.",
      cameraAngle: "medium wide shot",
      lighting: "glowing amber portal illumination against dusk sky",
    },
    {
      sceneNumber: 23,
      narrationText: "The three children stepped through safely, arriving back inside their familiar sunny attic.",
      environmentDescription: "The cozy attic floor surrounded by the familiar wooden chest and books.",
      action: "Mia, Leo, and Tara step out of the fading portal back onto attic wood planks.",
      characterNames: ["Mia", "Leo", "Tara"],
      supportingEntities: [],
      continuityAnchors: ["Attic chest: cedar chest open on the pine plank floor"],
      sceneDetails: "The children catch their breath with happy smiles, feeling accomplished.",
      cameraAngle: "medium shot",
      lighting: "warm golden twilight through attic dormer windows",
    },
    {
      sceneNumber: 24,
      narrationText: "Mia drew Trixie in her notebook, ready for their next time-travel adventure tomorrow.",
      environmentDescription: "A comfortable reading corner of the attic with cushions and warm lamplight.",
      action: "Mia sketches a friendly baby dinosaur in her brown notebook while Bobo rests contentedly.",
      characterNames: ["Mia", "Bobo the Backpack"],
      supportingEntities: [],
      continuityAnchors: ["Brown notebook: open on Mia's lap showing a neat pencil sketch of Trixie"],
      sceneDetails: "Mia closes the notebook with a peaceful smile as Bobo settles to sleep.",
      cameraAngle: "intimate close shot",
      lighting: "cozy warm reading lamp with gentle blue twilight outside",
    },
  ],
};

async function main() {
  console.log("=== Producing Series 17 Episode 1 Script and Audio Assets ===");

  const seriesState = new SeriesState();
  await seriesState.initialize();

  const seriesInfo = await seriesState.getSeriesInfo(17);
  if (!seriesInfo) throw new Error("Series 17 not found in Turso!");

  const episode = await seriesState.getEpisodeByNumber(17, 1);
  if (!episode) throw new Error("Episode 1 not found for Series 17!");

  const roster = (await seriesState.getSeriesCharacters(17)).map((c) => c.name);
  console.log(`Series: ${seriesInfo.conceptName} (ID: 17)`);
  console.log(`Episode: ${episode.title} (ID: ${episode.id})`);
  console.log(`Roster: ${roster.join(", ")}`);

  // 1. Validate script against production contract
  console.log("\n1. Validating 24-scene production script...");
  const inspection = inspectProductionScript(TIME_TRAVEL_EPISODE_1_SCRIPT, roster);
  if (!inspection.pass) {
    throw new Error(`Script inspection failed: ${inspection.issues.join(" | ")}`);
  }
  console.log(`   ✅ Script inspection PASSED (${inspection.sceneCount} scenes, ${inspection.totalSpokenWords} words).`);

  // 2. Persist canonical script to Turso DB
  console.log("\n2. Persisting script to Turso DB...");
  const scriptJson = canonicalEpisodeScriptJson(TIME_TRAVEL_EPISODE_1_SCRIPT as any);
  await client.execute({
    sql: `UPDATE episodes SET
      status = 'script',
      title = ?,
      script_json = ?,
      output_path = NULL,
      audio_revision = 0,
      audio_mutation_token = NULL,
      audio_mutation_scene_number = NULL,
      audio_mutation_expires_at_ms = NULL,
      youtube_video_id = NULL,
      uploaded_at = NULL,
      completed_at = NULL
    WHERE id = ?`,
    args: [TIME_TRAVEL_EPISODE_1_SCRIPT.title, scriptJson, episode.id],
  });
  console.log(`   ✅ Turso DB updated for episode ID ${episode.id}`);

  // 3. Reset local audio & agnes dirs
  console.log("\n3. Resetting local audio output directory...");
  const epDir = path.resolve(CONFIG.outputDir, "series_17", "episode_1");
  const audioDir = path.join(epDir, "audio");
  const agnesDir = path.join(epDir, "agnes_text");

  if (existsSync(audioDir)) await rm(audioDir, { recursive: true, force: true });
  await mkdir(audioDir, { recursive: true });

  if (existsSync(agnesDir)) await rm(agnesDir, { recursive: true, force: true });
  await mkdir(agnesDir, { recursive: true });

  // 4. Synthesize narration audio via Groq TTS
  console.log("\n4. Synthesizing narration audio tracks via Groq TTS...");
  const ttsTool = buildEpisodeTtsTool(seriesState);
  const ttsRawResult = await ttsTool.invoke({
    seriesId: 17,
    episodeNumber: 1,
  });
  const ttsResult = typeof ttsRawResult === "string" ? JSON.parse(ttsRawResult) : ttsRawResult;
  console.log(`   ✅ TTS Complete: ${ttsResult.sceneCount} scenes synthesized.`);

  // 5. Synthesize Key Art Audio
  console.log("\n5. Synthesizing key art audio...");
  const [seriesAudio, epAudio] = await ensureAgnesKeyArtAudioAssets({
    seriesId: 17,
    episodeNumber: 1,
    seriesTitle: seriesInfo.conceptName,
    episodeTitle: TIME_TRAVEL_EPISODE_1_SCRIPT.title,
    options: {
      outputDir: CONFIG.outputDir,
      audioMutationState: seriesState,
      allowMutation: true,
    },
  });
  console.log(`   ✅ Series key art audio: ${seriesAudio.audioPath} (${seriesAudio.durationSeconds.toFixed(1)}s)`);
  console.log(`   ✅ Episode key art audio: ${epAudio.audioPath} (${epAudio.durationSeconds.toFixed(1)}s)`);

  // 6. Verify preflight readiness
  console.log("\n6. Verifying audio & script readiness preflights...");
  await seriesState.assertEpisodeAudioReady(episode.id);
  await seriesState.assertEpisodeKeyArtAudioReady(17, 1);
  console.log("   ✅ Both assertEpisodeAudioReady and assertEpisodeKeyArtAudioReady passed!");

  console.log("\n=================================================");
  console.log("🎉 SUCCESS: Series 17 Episode 1 is 100% ready for runEpisodePipeline.ts!");
  console.log("=================================================\n");
}

const isDirectExecution = process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();

if (isDirectExecution) {
  main().catch((err) => {
    console.error("Failed to produce episode script & audio:", err);
    process.exit(1);
  });
}
