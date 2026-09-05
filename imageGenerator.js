import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(__dirname, 'generated_images');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`Created output directory: ${outputDir}`);
}

async function generateImage(prompt, model = 'google/gemini-3.1-flash-image', size = '1024x1024') {
  const apiKey = process.env.ANYAPI_KEY || 'any api key';
  
  try {
    const response = await fetch('https://api.anyapi.ai/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: prompt,
        model: model,
        n: 1,
        size: size,
        response_format: 'b64_json'
      })
    });

    const responseText = await response.text();
    
    if (!response.ok) {
      console.error('API Response:', responseText);
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const result = JSON.parse(responseText);
    if (!result.data || !result.data[0] || !result.data[0].b64_json) {
      throw new Error(`Invalid API response: ${responseText}`);
    }
    
    return result.data[0].b64_json;
  } catch (error) {
    console.error('Image generation failed:', error.message);
    console.log('\nNote: Make sure your API key is valid and has image generation credits.');
    console.log('Update the API key in the script or set ANYAPI_KEY environment variable.');
    throw error;
  }
}

async function saveImageFromBase64(base64Data, filename) {
  const buffer = Buffer.from(base64Data, 'base64');
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, buffer);
  console.log(`Image saved: ${filepath}`);
  return filepath;
}

// Build prompt from scene JSON
function buildPromptFromScene(sceneData) {
  const {
    narrationText,
    action,
    characterNames,
    environmentDescription,
    cameraAngle,
    lighting
  } = sceneData;

  const prompt = `
Scene: ${narrationText}

Characters: ${characterNames.join(', ')}
Action: ${action}
Environment: ${environmentDescription}
Camera: ${cameraAngle}
Lighting: ${lighting}

Create a cinematic, high-quality illustration matching this scene description.
  `.trim();

  return prompt;
}

// Usage
async function main() {
  try {
    const sceneData = {
      "sceneNumber": 1,
      "narrationText": "In the peaceful meadow as the sun sets, Luna the Firefly glows softly, watching a family of mice prepare to walk home.",
      "action": "Luna the Firefly glows softly, observing the meadow.",
      "characterNames": [
        "Luna the Firefly"
      ],
      "environmentDescription": "A sunny green meadow filled with tall grass, colorful wildflowers, and buzzing insects.",
      "cameraAngle": "wide cinematic shot",
      "lighting": "soft twilight glow"
    };

    console.log('Scene Data:', JSON.stringify(sceneData, null, 2));
    const prompt = buildPromptFromScene(sceneData);
    console.log('\nGenerated Prompt:\n', prompt);
    console.log('\nGenerating image...');
    
    const base64Data = await generateImage(prompt);
    console.log('Image generated (base64 length:', base64Data.length, ')');

    const filename = `scene_${sceneData.sceneNumber}_${Date.now()}.png`;
    const savedPath = await saveImageFromBase64(base64Data, filename);
    console.log('Saved to:', savedPath);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Generate multiple variations
async function generateVariations(basePrompt, variations) {
  const images = [];

  for (const variation of variations) {
    const fullPrompt = `${basePrompt}, ${variation}`;
    console.log(`Generating: ${fullPrompt}`);
    
    try {
      const base64Data = await generateImage(fullPrompt);
      const sanitizedPrompt = variation.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const filename = `${sanitizedPrompt}_${Date.now()}.png`;
      const savedPath = await saveImageFromBase64(base64Data, filename);
      images.push({ prompt: fullPrompt, path: savedPath });
    } catch (error) {
      console.error(`Failed to generate variation "${variation}":`, error.message);
    }
  }

  return images;
}

// Example usage
async function exampleVariations() {
  try {
    const variations = [
      'in watercolor style',
      'in digital art style',
      'in photorealistic style',
      'in minimalist style'
    ];

    console.log('\nGenerating variations...');
    const images = await generateVariations('A cute robot character', variations);
    
    console.log('\nGenerated images:');
    images.forEach(img => {
      console.log(`Prompt: ${img.prompt}`);
      console.log(`Path: ${img.path}`);
      console.log('---');
    });
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Run main example
main();

// Uncomment to run variations example instead
// exampleVariations();
