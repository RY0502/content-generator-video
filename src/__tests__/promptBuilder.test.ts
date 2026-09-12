import { describe, expect, it } from "vitest";
import {
  buildEpisodeKeyArtPrompt,
  buildEpisodeKeyArtVideoPrompt,
  buildSeriesKeyArtPrompt,
  buildSeriesKeyArtVideoPrompt,
  buildStylizedScenePrompt,
  resolveCameraPreset,
  resolveSceneLightingProfile,
  TEMPORAL_STABILITY_NEGATIVE_BIBLE,
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

    expect(prompt).toContain("SUPPORTING IDENTITY REFERENCES");
    expect(prompt).toContain("[Ant leader]: tiny black ant with a shiny chestnut head");
    expect(prompt).toContain("INANIMATE CONTINUITY");
    expect(prompt).toContain("Picnic setup: red-and-white checkered blanket spread on grass with sandwiches and leaf cups.");
    expect(prompt).toContain("[Pip the Ant]: small red ant");
    expect(prompt).toContain("VISIBLE CAST — EXACTLY 2 FIGURES, NO OTHERS");
    expect(prompt).toContain("[Pip the Ant] × 1; [Ant leader] × 1");
    expect(prompt).toContain("ACTION AND CHANGE — ONE CONTINUOUS BEAT");
    expect(prompt).toContain("unlisted figures");
    expect(prompt).toContain("No duplicate characters");
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

    expect(prompt).toContain("BODY-FORM LOCK");
    expect(prompt).toContain("Butterfly (butterfly)");
    expect(prompt).toContain("use natural species body plans, stance, and locomotion");
    expect(prompt).toContain("never humanoid arms or hands");
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

    expect(prompt).toContain("BODY-FORM LOCK");
    expect(prompt).toContain("Felix the Fox (red fox) may pose upright");
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

    expect(prompt).toContain("Emotions: happy");
    expect(prompt).toContain("Poses: standing tall");
    expect(prompt).toContain("Movement reference: waving one arm");
    expect(prompt).toContain("Props/interactions: Props: wooden door slightly open.");
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

    expect(prompt).toContain("EMPTY-SCENE LOCK");
    expect(prompt).toContain("exactly zero people, animals, creatures, living objects, silhouettes, or other figures");
    expect(prompt).toContain("No people, children, animals, creatures, living objects, or figures.");
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

    expect(prompt).toContain("MAIN-CAST EXCLUSION");
    expect(prompt).toContain("SUPPORTING IDENTITY REFERENCES");
    expect(prompt).toContain("VISIBLE CAST — EXACTLY 1 FIGURE, NO OTHERS");
    expect(prompt).not.toContain("EMPTY-SCENE LOCK");
    expect(prompt).not.toContain("No people, children, animals, creatures, living objects, or figures.");
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

    expect(prompt).toContain("species-correct anatomy");
    expect(prompt).toContain("use natural species body plans, stance, and locomotion");
    expect(prompt).toContain("duplicated appendages beyond the locked species/body form");
    expect(prompt).not.toContain("exactly two arms/forelegs and two legs/hindlegs");
    expect(prompt).not.toContain("exactly two hands/paws");
    expect(prompt).not.toContain("three arms, three hands, three legs");
    expect(prompt).toContain("No duplicate characters");
    expect(prompt).toContain("No extra limbs or duplicated appendages beyond the locked species/body form");
    expect(prompt).toContain("No double heads or extra heads, duplicated faces, fused heads, or conjoined bodies");
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

  it("orders direct-video guidance and normalizes unsafe camera prose to one cast-compatible plan", () => {
    const prompt = buildStylizedScenePrompt({
      characterNames: ["Mia", "Leo", "Bobo"],
      characterVisuals: [
        { name: "Mia", visualForm: "humanoid", speciesOrType: "young girl" },
        { name: "Leo", visualForm: "humanoid", speciesOrType: "young boy" },
        { name: "Bobo", visualForm: "object_character", speciesOrType: "living backpack" },
      ],
      characterDescriptions: [
        "young girl, yellow shirt. Always same colors.",
        "young boy, green shirt. Always same colors.",
        "small sky-blue living backpack. Always same colors.",
      ],
      environmentDescription: "A fern-lined valley with one round leaf nest beside a shallow stream.",
      action: "Mia points while the others take one careful step toward the nest.",
      narrationText: "The friends spotted the nest and moved closer.",
      cameraAngle: "close tracking shot from creek level moving slowly right",
      lighting: "warm amber late-afternoon light with soft fern shadows",
      continuityAnchors: ["Nest: round woven green leaves beside the same shallow stream."],
      sceneDetails: "Mia stands front-left pointing; Leo follows at right; Bobo bounces once behind them.",
    });

    const sections = [
      "SUBJECT AND SETTING",
      "ACTION AND CHANGE",
      "CAMERA",
      "VISUAL STYLE",
      "SOUND AND RHYTHM",
      "CONSISTENCY REQUIREMENTS",
    ].map((section) => prompt.indexOf(section));
    expect(sections.every((index) => index >= 0)).toBe(true);
    expect(sections).toEqual([...sections].sort((left, right) => left - right));
    expect(prompt).toContain("medium-wide 16:9 group composition");
    expect(prompt).toContain("gentle low-angle viewpoint; slow track right");
    expect(prompt).not.toContain("Authored camera intent");
    expect(prompt).not.toContain("close tracking shot from creek level moving slowly right");
    expect(prompt).toContain("Nest: round woven green leaves beside the same shallow stream.");
    expect(prompt).toContain("LIGHTING PROFILE (DUSK)");
    expect(prompt).not.toContain("warm amber late-afternoon light with soft fern shadows");
    expect(prompt).toContain(TEMPORAL_STABILITY_NEGATIVE_BIBLE);
    expect(prompt).toContain("VISIBLE CAST — EXACTLY 3 FIGURES, NO OTHERS");
    expect(prompt).toContain("[Mia] × 1; [Leo] × 1; [Bobo] × 1");
    expect(prompt).toContain("OBJECT-CHARACTER LOCK");
    expect(prompt).toContain("carried/worn OR freestanding, never both");
    expect(prompt).not.toContain("The friends spotted the nest and moved closer");
  });

  it("keeps any authored cast size while locking its exact figure count", () => {
    const prompt = buildStylizedScenePrompt({
      characterNames: ["Mia", "Leo", "Tara", "Bobo"],
      characterDescriptions: ["girl", "boy", "girl", "living backpack"],
      environmentDescription: "A clear path.",
      action: "Mia points while Leo watches, Tara smiles, and Bobo bounces once.",
      narrationText: "The friends look ahead.",
      cameraAngle: "wide",
      lighting: "warm daylight",
    });

    expect(prompt).toContain("VISIBLE CAST — EXACTLY 4 FIGURES, NO OTHERS");
    expect(prompt).toContain("[Mia] × 1; [Leo] × 1; [Tara] × 1; [Bobo] × 1");
    expect(prompt).toContain("keep those same 4 ledger identities");
  });

  it("uses dedicated direct-video title cards without legacy still-media bias", () => {
    const seriesPrompt = buildSeriesKeyArtVideoPrompt({
      conceptName: "Tiny Heroes Club",
      conceptSummary: "Small friends solve gentle meadow problems together.",
      environmentDescription: "A sunny meadow beside a tiny wooden clubhouse.",
      characterNames: ["Pip", "Bobo"],
      characterDescriptions: [
        "tiny ruby-red ant with six legs and a yellow backpack",
        "small cobalt-blue living backpack with an amber zipper",
      ],
    });
    const episodePrompt = buildEpisodeKeyArtVideoPrompt({
      conceptName: "Tiny Heroes Club",
      episodeTitle: "The Berry Bridge",
      episodePremise: "Pip carries a berry over a little stream.",
      environmentDescription: "A sunny meadow beside a tiny wooden clubhouse.",
      mainCharacterName: "Pip",
      mainCharacterDescription: "tiny ruby-red ant with six legs and a yellow backpack",
      otherCharacters: [{
        name: "Bobo",
        description: "small cobalt-blue living backpack with an amber zipper",
      }],
      supportingEntities: ["Berry: one glossy raspberry-red berry with a green leaf"],
    });

    for (const prompt of [seriesPrompt, episodePrompt]) {
      expect(prompt).not.toMatch(/\b(?:poster|thumbnail|cover|image)\b/i);
      expect(prompt).toContain("SUBJECT AND SETTING");
      expect(prompt).toContain("ACTION AND CHANGE");
      expect(prompt).toContain("CAMERA");
      expect(prompt).toContain("VISUAL STYLE");
      expect(prompt).toContain("SOUND AND RHYTHM");
      expect(prompt).toContain("CONSISTENCY REQUIREMENTS");
      expect(prompt).toContain("silent visual-only title card");
      expect(prompt).not.toContain("provider audio track will be discarded");
      expect(prompt).toContain(TEMPORAL_STABILITY_NEGATIVE_BIBLE);
      expect(prompt).toContain("No duplicate characters");
      expect(prompt).toContain("No extra limbs");
      expect(prompt).toContain("No double heads");
    }
    expect(seriesPrompt).toContain("EXACT ON-SCREEN CAST LEDGER — 1 TOTAL CHARACTER FIGURE, AND NO OTHERS");
    expect(seriesPrompt).toContain("[Pip] × 1");
    expect(seriesPrompt).toContain("A sunny meadow beside a tiny wooden clubhouse");
    expect(seriesPrompt).not.toContain("Small friends solve gentle meadow problems together");
    expect(seriesPrompt).not.toContain("small cobalt-blue living backpack with an amber zipper");
    expect(episodePrompt).toContain("EXACT ON-SCREEN CAST LEDGER — 1 TOTAL CHARACTER FIGURE, AND NO OTHERS: [Pip] × 1");
    expect(episodePrompt).not.toContain("Pip carries a berry over a little stream");
    expect(episodePrompt).not.toContain("OPTIONAL NAMED CAST");
    expect(episodePrompt).not.toContain("Berry: one glossy raspberry-red berry with a green leaf");
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

    expect(prompt).toContain("same exact age, gender presentation, face, hair, eyes, body form, proportions, colors, markings, clothing, and accessories");
    expect(prompt).toContain("Do not add, remove, exchange, recolor, or redesign identity traits or wardrobe");
    expect(prompt).toContain("unlisted wardrobe/accessories/markings");
  });

  it("preserves exact age and portrait identity text without summarizing it", () => {
    const identity = "EXACT AGE 5-year-old young girl; chestnut bob; amber eyes; yellow shirt. Portrait lock: round cheeks, red shoes.";
    const prompt = buildStylizedScenePrompt({
      characterNames: ["Mia"],
      characterDescriptions: [identity],
      environmentDescription: "A sunny park path.",
      action: "Mia raises one hand and smiles.",
      narrationText: "Mia waved.",
      cameraAngle: "medium fixed camera",
      lighting: "bright morning sunlight",
    });

    expect(prompt).toContain(`[Mia]: ${identity}`);
    expect(prompt).toContain("same exact age");
  });

  it("uses a bounded lighting palette so equivalent scene prose keeps one grade", () => {
    expect(resolveSceneLightingProfile("warm amber late-afternoon light")).toBe("dusk");
    expect(resolveSceneLightingProfile("golden-hour sunlight")).toBe("dusk");
    expect(resolveSceneLightingProfile("moonlit blue night")).toBe("night");
    expect(resolveSceneLightingProfile("late-afternoon light", "inside an ancient tomb")).toBe("interior");
    expect(resolveSceneLightingProfile("soft golden morning light")).toBe("daylight");
  });

  it("removes split-screen and competing authored camera grammar", () => {
    const prompt = buildStylizedScenePrompt({
      characterNames: ["Mia", "Leo"],
      characterDescriptions: ["five-year-old girl", "five-year-old boy"],
      environmentDescription: "A quiet library.",
      action: "Mia points to one book while Leo watches.",
      narrationText: "They found the clue.",
      cameraAngle: "split-screen over-the-shoulder close-up, pan left then orbit and zoom in",
      lighting: "warm indoor lamplight",
    });

    expect(prompt).toContain("medium-wide 16:9 group composition");
    expect(prompt).toContain("slow straight push-in");
    expect(prompt).not.toContain("over-the-shoulder close-up");
    expect(prompt).not.toContain("orbit");
    expect(prompt).not.toContain("pan left then");
  });

  it("rejects duplicate cast declarations but never imposes an arbitrary cast ceiling", () => {
    expect(() => buildStylizedScenePrompt({
      characterNames: ["Mia", "Mia"],
      characterDescriptions: ["five-year-old girl", "five-year-old girl"],
      environmentDescription: "A sunny path.",
      action: "Mia waves.",
      narrationText: "Mia waved.",
      cameraAngle: "wide",
      lighting: "daylight",
    })).toThrow("each main character exactly once");

    const names = Array.from({ length: 7 }, (_, index) => `Character ${index + 1}`);
    const prompt = buildStylizedScenePrompt({
      characterNames: names,
      characterDescriptions: names.map((name) => `${name}, one distinct child`),
      environmentDescription: "A broad school stage.",
      action: names.map((name) => `${name} holds one fixed place`).join(" while "),
      narrationText: "Everyone held their place.",
      cameraAngle: "wide fixed camera",
      lighting: "soft daylight",
    });
    expect(prompt).toContain("VISIBLE CAST — EXACTLY 7 FIGURES, NO OTHERS");
  });

  it("keeps provider boilerplate bounded while retaining all authored visual payload", () => {
    const identities = ["Mia", "Leo", "Tara", "Bobo"].map(
      (name) => `${name}: ${name[0]!.repeat(394)}`,
    );
    const environment = `Ancient courtyard: ${"e".repeat(240)}`;
    const action = `Mia points once while Leo, Tara, and Bobo hold their places: ${"a".repeat(115)}`;
    const details = `Exact blocking: ${"d".repeat(340)}`;
    const authoredPayloadLength = identities.join("").length + environment.length + action.length + details.length;
    const prompt = buildStylizedScenePrompt({
      characterNames: ["Mia", "Leo", "Tara", "Bobo"],
      characterDescriptions: identities,
      environmentDescription: environment,
      action,
      narrationText: "Unused by the visual prompt.",
      sceneDetails: details,
      cameraAngle: "wide fixed camera",
      lighting: "warm daylight",
    });

    for (const value of [...identities, environment, action, details]) expect(prompt).toContain(value);
    expect(prompt.length - authoredPayloadLength).toBeLessThan(3_300);
  });
});
