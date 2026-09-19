import "dotenv/config";
import { SeriesState } from "../src/state/seriesState.js";

async function main() {
  const ss = new SeriesState();
  const ep = await ss.getEpisodeById(201);
  if (!ep?.scriptJson) {
    console.log("No scriptJson on episode 201");
    return;
  }
  const script = typeof ep.scriptJson === "string" ? JSON.parse(ep.scriptJson) : ep.scriptJson;
  console.log("Title:", script.title);
  console.log("Premise:", script.premise);
  console.log("Scene count:", script.scenes?.length);
  script.scenes?.forEach((s: any, idx: number) => {
    console.log(`\n--- Scene ${s.sceneNumber ?? idx + 1} ---`);
    console.log("Narration:", s.narrationText);
    console.log("Characters:", s.characterNames);
    console.log("Environment:", s.environmentDescription);
    console.log("Action:", s.action);
    console.log("SupportingEntities:", s.supportingEntities);
    console.log("ContinuityAnchors:", s.continuityAnchors);
    console.log("Lighting:", s.lighting);
    console.log("Camera:", s.cameraAngle);
  });
}

main().catch(console.error);
