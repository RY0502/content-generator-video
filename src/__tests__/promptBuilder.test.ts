import { describe, expect, it } from "vitest";
import {
  buildEpisodeKeyArtPrompt,
  buildSeriesKeyArtPrompt,
  buildStylizedScenePrompt,
  resolveCameraPreset,
} from "../promptBuilder.js";

describe("promptBuilder", () => {
  it("includes recurring supporting entities and single-moment guidance in scene prompts", () => {
    const prompt = buildStylizedScenePrompt({
      characterNames: ["Pip the Ant"],
      characterDescriptions: [
        "small red ant, yellow backpack, bright round eyes, brave posture. Always same colors.",
      ],
      environmentDescription: "A wide sunny meadow with tall grass and a red picnic blanket.",
      action: "Pip the Ant points toward the picnic blanket while the ant leader pauses nearby.",
      narrationText: "Pip the Ant gasped softly and pointed toward the picnic blanket as the tiny ant leader paused to listen.",
      cameraAngle: "wide establishing shot",
      lighting: "warm morning sunlight",
      supportingEntities: ["Ant leader: tiny black ant with a shiny chestnut head"],
      continuityAnchors: ["Picnic setup: red-and-white checkered blanket spread on grass with sandwiches and leaf cups."],
      sceneDetails: "Pip the Ant: worried, leaning forward, pointing with one leg. Ant leader: paused, antennae lifted. Props: red picnic blanket with sandwiches in the distance.",
    });

    expect(prompt).toContain("SUPPORTING ENTITIES");
    expect(prompt).toContain("Ant leader: tiny black ant with a shiny chestnut head");
    expect(prompt).toContain("CONTINUITY ANCHORS");
    expect(prompt).toContain("Picnic setup: red-and-white checkered blanket spread on grass with sandwiches and leaf cups.");
    expect(prompt).toContain("Pip the Ant appearance");
    expect(prompt).toContain("EXACT TOTAL FIGURE COUNT RULE — show exactly 2 individual character figures total");
    expect(prompt).toContain("1 main-character figure plus 1 supporting-entity figure");
    expect(prompt).not.toContain("Exactly 1 individual character figures total");
    expect(prompt).toContain("Animate this single visible beat as one coherent shot");
    expect(prompt).toContain("extra or wrong characters beyond those explicitly required for the scene");
    expect(prompt).toContain("spark symbols, sparkle marks, glowing stars");
    expect(prompt).toContain("decorative symbols/emblems on characters' faces or foreheads");
  });

  it("keeps real creatures in their natural body form", () => {
    const prompt = buildStylizedScenePrompt({
      characterNames: ["Sunny the Sparrow", "Butterfly"],
      characterVisuals: [
        { name: "Sunny the Sparrow", visualForm: "real_creature", speciesOrType: "sparrow", humanoidAllowed: false },
        { name: "Butterfly", visualForm: "real_creature", speciesOrType: "butterfly", humanoidAllowed: true },
      ],
      characterDescriptions: [
        "small sparrow, sunflower-yellow chest, slate-grey wings, bright eyes. Always same colors.",
        "tiny orange butterfly, delicate torn wings, slim dark body, thin antennae. Always same colors.",
      ],
      environmentDescription: "The meadow path between the clover and the creek.",
      action: "Sunny the Sparrow flies ahead while the Butterfly lifts off from the clover.",
      narrationText: "Sunny led the way as the lost butterfly fluttered up behind her.",
      cameraAngle: "medium",
      lighting: "soft golden morning light",
      sceneDetails: "Sunny glances back over her shoulder while the small butterfly lifts into the air with torn orange wings visible.",
    });

    expect(prompt).toContain("CREATURE IDENTITY GUIDE");
    expect(prompt).toContain("Butterfly (butterfly)");
    expect(prompt).toContain("REAL CREATURE BODY RULE");
    expect(prompt).toContain("must keep natural species anatomy, body plan, stance, and locomotion");
    expect(prompt).toContain("never give a real creature an upright anthropomorphic or human-shaped body");
    expect(prompt).not.toContain("Anthropomorphic styling (walking upright, expressive faces) is acceptable");
  });

  it("allows an explicitly anthropomorphic creature to use an upright body form", () => {
    const prompt = buildStylizedScenePrompt({
      characterNames: ["Felix the Fox"],
      characterVisuals: [
        {
          name: "Felix the Fox",
          visualForm: "anthropomorphic_creature",
          speciesOrType: "red fox",
          humanoidAllowed: false,
        },
      ],
      characterDescriptions: [
        "small russet-red fox standing upright, cream muzzle, green waistcoat. Always same colors.",
      ],
      environmentDescription: "A cozy woodland library.",
      action: "Felix carries one book toward a low shelf.",
      narrationText: "Felix carefully returned the book.",
      cameraAngle: "medium",
      lighting: "warm lamplight",
    });

    expect(prompt).toContain("ANTHROPOMORPHIC CREATURE BODY RULE");
    expect(prompt).toContain("Felix the Fox (red fox) may stand or walk upright");
    expect(prompt).not.toContain("Felix the Fox (red fox) must keep natural species anatomy, body plan, stance, and locomotion");
  });

  it("falls back to legacy emotion and prop fields when sceneDetails is absent", () => {
    const prompt = buildStylizedScenePrompt({
      characterDescriptions: ["small red ant, yellow backpack. Always same colors."],
      environmentDescription: "A cozy clubhouse",
      action: "Pip the Ant waves hello",
      narrationText: "Pip the Ant smiled and waved hello.",
      cameraAngle: "medium",
      lighting: "soft morning light",
      characterEmotions: ["happy"],
      characterPoses: ["standing tall"],
      characterMovements: ["waving one arm"],
      objectInteractions: "Props: wooden door slightly open.",
    });

    expect(prompt).toContain("EMOTIONS: happy");
    expect(prompt).toContain("POSES: standing tall");
    expect(prompt).toContain("MOVEMENTS: waving one arm");
    expect(prompt).toContain("PROPS/INTERACTIONS: Props: wooden door slightly open.");
  });

  it("generates a strict scenery-only prompt and negative tokens when no characters are in the scene", () => {
    const prompt = buildStylizedScenePrompt({
      characterNames: [],
      characterDescriptions: [],
      environmentDescription: "A bright green meadow filled with colorful wildflowers and fireflies at dusk.",
      action: "Fireflies glow softly over the darkening meadow grass.",
      narrationText: "As dusk settled over the meadow, tiny yellow fireflies began to blink into the evening sky.",
      cameraAngle: "establishing",
      lighting: "cool blue dusk with fireflies",
    });

    expect(prompt).toContain("SCENERY / ENVIRONMENT ONLY");
    expect(prompt).toContain("Exactly 0 characters");
    expect(prompt).toContain("No people, no children, no kids, no humans, no animals, no figures, no characters of any kind");
    expect(prompt).toContain("Avoid: any people, humans, persons, children, kids, toddlers, boys, girls, babies, animals, creatures, characters, figures, silhouettes of people.");
  });

  it("treats supporting-only scenes as populated rather than scenery-only", () => {
    const prompt = buildStylizedScenePrompt({
      characterNames: [],
      characterDescriptions: [],
      supportingEntities: [
        "Lost butterfly: tiny orange butterfly with six slim legs, two torn wings, dark body, and thin antennae",
      ],
      environmentDescription: "A clover patch beside a shallow creek.",
      action: "The lost butterfly rests on one clover flower.",
      narrationText: "A tired butterfly waited quietly by the creek.",
      cameraAngle: "close",
      lighting: "soft morning light",
    });

    expect(prompt).toContain("exactly 0 main-series character figures");
    expect(prompt).toContain("This is NOT a scenery-only scene");
    expect(prompt).toContain("SUPPORTING ENTITIES");
    expect(prompt).toContain("EXACT TOTAL FIGURE COUNT RULE — show exactly 1 individual character figure total");
    expect(prompt).toContain("0 main-character figures plus 1 supporting-entity figure");
    expect(prompt).not.toContain("SCENERY / ENVIRONMENT ONLY");
    expect(prompt).not.toContain("No people, no children, no kids, no humans, no animals, no figures");
    expect(prompt).not.toContain("Avoid: any people, humans, persons, children, kids, toddlers, boys, girls, babies, animals, creatures");
  });

  it("uses species-correct anatomy instead of a two-arm/two-leg constraint", () => {
    const prompt = buildStylizedScenePrompt({
      characterNames: ["Pip the Ant", "Sia the Snake"],
      characterVisuals: [
        { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant" },
        { name: "Sia the Snake", visualForm: "real_creature", speciesOrType: "snake" },
      ],
      characterDescriptions: [
        "tiny red ant with six legs and two antennae. Always same colors.",
        "slender emerald-green snake with no legs. Always same colors.",
      ],
      environmentDescription: "A sunlit clearing in the forest.",
      action: "Pip walks beside Sia along the mossy path.",
      narrationText: "Pip and Sia followed the path together.",
      cameraAngle: "medium",
      lighting: "warm morning sunlight",
    });

    expect(prompt).toContain("species-correct anatomy and the natural or authored number and type");
    expect(prompt).toContain("insects may have six legs, snakes may have no legs, and birds have wings plus legs");
    expect(prompt).toContain("extra or duplicated appendages beyond the character's locked species and body form");
    expect(prompt).not.toContain("exactly two arms/forelegs and two legs/hindlegs");
    expect(prompt).not.toContain("exactly two hands/paws");
    expect(prompt).not.toContain("three arms, three hands, three legs");
    expect(prompt).toContain("No duplicate characters");
    expect(prompt).toContain("No extra limbs or duplicated appendages beyond each character's locked species and body form");
    expect(prompt).toContain("No double heads, extra heads, duplicated faces, fused heads, or conjoined heads");
  });

  it("applies the same explicit character-integrity negative bible to both key-art prompts", () => {
    const seriesPrompt = buildSeriesKeyArtPrompt({
      conceptName: "Tiny Heroes Club",
      conceptSummary: "Small friends solve gentle meadow problems together.",
      characterNames: ["Pip"],
      characterDescriptions: ["Tiny ruby-red ant with six legs and a yellow backpack."],
    });
    const episodePrompt = buildEpisodeKeyArtPrompt({
      conceptName: "Tiny Heroes Club",
      episodeTitle: "The Berry Bridge",
      episodePremise: "Pip carries a berry over a little stream.",
      mainCharacterName: "Pip",
      mainCharacterDescription: "Tiny ruby-red ant with six legs and a yellow backpack.",
    });

    for (const prompt of [seriesPrompt, episodePrompt]) {
      expect(prompt).toContain("No duplicate characters");
      expect(prompt).toContain("No extra limbs");
      expect(prompt).toContain("No double heads");
    }
  });

  it("maps freeform camera strings to the locked presets", () => {
    expect(resolveCameraPreset("close up shot")).toBe("close");
    expect(resolveCameraPreset("medium two-shot")).toBe("medium");
    expect(resolveCameraPreset("birds eye wide")).toBe("establishing");
  });

  it("enforces locked wardrobe and suppresses unrequested hats, dresses, and clothing in negative bible", () => {
    const prompt = buildStylizedScenePrompt({
      characterNames: ["Ella the Elephant"],
      characterDescriptions: ["gray elephant, blue bow. Always same colors."],
      environmentDescription: "A peaceful riverbank with smooth stones.",
      action: "Ella walks along the shore.",
      narrationText: "Ella walked along the riverbank.",
      cameraAngle: "medium",
      lighting: "soft morning light",
    });

    expect(prompt).toContain("Characters must wear or carry ONLY what is explicitly specified in their locked description");
    expect(prompt).toContain("never add unrequested clothing, hats, caps, sunhats, dresses, shirts, shoes, bags, satchels, or glasses");
    expect(prompt).toContain("unrequested hats, sunhats, unrequested dresses, unrequested shirts, unrequested clothing or outfits on non-clothed characters, unrequested extra backpacks or bags");
  });
});
