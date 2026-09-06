import "dotenv/config";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { generateAnyApiSceneImage } from "../src/providers/anyApiImageClient.js";
import { assertLegacyImageFlowOptIn } from "./legacyImageFlowGuard.js";

async function testAnyApiImage() {
  assertLegacyImageFlowOptIn(
    "testAnyApiImage.ts",
    "direct paid AnyAPI scene-image smoke test",
  );
  const prompt = `
Full environmental storybook scene illustration, 16:9 landscape composition — wide establishing shot with characters acting inside the location, NOT a character portrait or plain background.
SETTING: A sunny green meadow filled with tall grass, colorful wildflowers, and buzzing insects.
STORY MOMENT: In the peaceful meadow as the sun sets, Luna the Firefly glows softly, watching a family of mice prepare to walk home.
VISIBLE ACTION: Luna the Firefly glows softly, observing the meadow.
EMOTION: peaceful and gentle
POSE: hovering in mid-air with wings spread
SHOT: wide cinematic shot, wide-to-medium composition
LIGHT: soft twilight glow, bright soft cheerful illumination
  `.trim();

  console.log("Testing AnyAPI scene image generation...");
  console.log("Prompt:", prompt.substring(0, 200) + "...");
  
  try {
    const startTime = Date.now();
    const buffer = await generateAnyApiSceneImage(prompt);
    const duration = Date.now() - startTime;
    
    console.log(`✓ Image generated successfully in ${duration}ms`);
    console.log(`  Buffer size: ${buffer.length} bytes (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    
    const outputPath = path.join("output", "test-anyapi-scene.png");
    await writeFile(outputPath, buffer);
    console.log(`✓ Image saved to: ${outputPath}`);
    
  } catch (error) {
    console.error("✗ Image generation failed:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

testAnyApiImage();
