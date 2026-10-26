import "dotenv/config";
import { SeriesState } from "../src/state/seriesState.js";

async function main() {
  const state = new SeriesState();
  try {
    await state.initialize();
    const ep = await state.getEpisodeByNumber(22, 2);
    if (!ep) return;
    const scenes = (ep.scriptJson as any).scenes;
    for (const sc of scenes) {
      console.log(`\n=== SCENE ${sc.sceneNumber} ===`);
      console.log(`Action: ${sc.action}`);
      console.log(`Env: ${sc.environmentDescription}`);
      console.log(`Anchors: ${JSON.stringify(sc.continuityAnchors)}`);
      console.log(`Narration: ${sc.narrationText}`);
    }
  } finally {
    await state.close();
    process.exit(0);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
