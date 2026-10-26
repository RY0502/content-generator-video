import { SeriesState } from "../src/state/seriesState.js";

async function main() {
  const s = new SeriesState();
  try {
    const ep = await s.getEpisodeByNumber(22, 2);
    if (!ep || !ep.scriptJson) {
      console.log("No episode or script found");
      return;
    }
    const scenes = (ep.scriptJson as any).scenes;
    for (const sc of scenes) {
      console.log(`--- SCENE ${sc.sceneNumber} ---`);
      console.log("Action:", sc.action);
      console.log("Env:", sc.environmentDescription);
      console.log("Anchors:", sc.continuityAnchors);
      console.log("Narration:", sc.narrationText);
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await s.close();
    process.exit(0);
  }
}

main();
