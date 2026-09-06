import "dotenv/config";
import path from "node:path";
import { SeriesState, type CharacterDef, type EnvironmentDef } from "../src/state/seriesState.js";
import { buildCharacterSheetTool } from "../src/tools/characterSheetTool.js";
import { buildSeriesKeyArtTool, buildEpisodeKeyArtTool } from "../src/tools/keyArtTool.js";
import { buildSceneImageTool } from "../src/tools/sceneImageTool.js";
import { CONFIG } from "../src/config.js";
import { assertLegacyImageFlowOptIn } from "./legacyImageFlowGuard.js";

interface SceneDef {
  sceneNumber: number;
  environmentDescription: string;
  action: string;
  narrationText: string;
  cameraAngle: string;
  lighting: string;
  characterNames: string[];
  characterVisuals?: Array<{ name: string; visualForm: string; speciesOrType?: string; humanoidAllowed: boolean }>;
  supportingEntities?: string[];
  continuityAnchors?: string[];
  sceneDetails: string;
}

interface ConceptTestConfig {
  id: number;
  conceptName: string;
  conceptSummary: string;
  formula: string;
  characters: CharacterDef[];
  environments: EnvironmentDef[];
  season1Episodes: Array<{ episodeNumber: number; title: string; premise: string }>;
  nextEpisode: {
    episodeNumber: number;
    title: string;
    premise: string;
    mainCharacterName: string;
    scenes: SceneDef[];
  };
}

export const CONCEPTS: ConceptTestConfig[] = [
  // ==========================================
  // CONCEPT 1: Time-Travel Backpack
  // ==========================================
  {
    id: 1,
    conceptName: "Time-Travel Backpack",
    conceptSummary:
      "A magical living backpack opens portals to different times, places, and worlds. Three children explore these worlds and become involved in an adventure, mystery, or problem.",
    formula:
      "Preschool time-travel adventure with wonder, humor, gentle problem-solving, and one main educational discovery. 1 scene = 1 image = 1 narration clip.",
    characters: [
      {
        name: "Mia",
        description:
          "A curious and imaginative 5-year-old girl with cute short chin-length chestnut brown hair (cute girl bob cut, no earrings), wearing a vibrant yellow t-shirt, cuffed blue jeans, red sneakers, and holding a brown notebook. Feminine young girl features.",
      },
      {
        name: "Leo",
        description:
          "A brave and energetic 5-year-old boy with short messy black hair, wearing a forest green t-shirt, earthy brown cargo shorts, and orange sneakers. Energetic young boy features.",
      },
      {
        name: "Tara",
        description:
          "An observant and logical 5-year-old girl with long jet-black hair tied in a high bouncy ponytail with a purple hairband, wearing a purple t-shirt, denim blue skirt, and yellow boots. Thoughtful young girl features.",
      },
      {
        name: "Bobo the Backpack",
        description:
          "A magical living backpack with bright sky-blue fabric, yellow straps, button eyes, stitched smile, and small blue cartoon arms and legs. Bobo is playful and expressive.",
      },
    ],
    environments: [
      {
        name: "Backyard Clubhouse",
        description: "A cozy sunlit backyard near a large leafy oak tree with a neat wooden picket fence and flower bushes.",
      },
      {
        name: "Moon Colony Biodome",
        description: "A futuristic transparent glass dome on the bright white lunar surface, with dark starry space and glowing Earth above.",
      },
    ],
    season1Episodes: [
      { episodeNumber: 1, title: "The Dinosaur Who Lost His Roar", premise: "The children arrive in a prehistoric valley and help a young dinosaur find his voice and confidence." },
      { episodeNumber: 2, title: "The Moon Robot's Missing Wheel", premise: "The children arrive at a Moon colony and help a small robot retrieve a wheel that has floated away in low gravity." },
      { episodeNumber: 3, title: "The Pyramid's Painted Cat", premise: "In Ancient Egypt, the children follow colorful paw prints through sunlit courtyards to help a lost temple kitten find its garden." },
      { episodeNumber: 4, title: "The Woolly Mammoth's Cozy Scarf", premise: "In the Ice Age, the children help a baby mammoth stay warm while discovering how arctic animals adapt to the cold." },
      { episodeNumber: 5, title: "The Pirate Parrot's Shiny Button", premise: "On a tropical pirate island, the children search tidal pools to find a lost golden button for a friendly parrot's vest." },
      { episodeNumber: 6, title: "The Coral Reef's Gentle Glow", premise: "In the deep ocean, the children guide a baby sea turtle along a path of bioluminescent sea anemones." },
      { episodeNumber: 7, title: "The Rainforest Rain Dance", premise: "In the Amazon rainforest, the children mimic tree frogs and toucans to welcome a refreshing afternoon sun-shower." },
      { episodeNumber: 8, title: "The Mars Rover's Sand Castle", premise: "On Mars, the children help a friendly exploration rover build a red-dust windbreak to keep its solar panels clean." },
      { episodeNumber: 9, title: "The Flying City's Cloud Kite", premise: "In future Earth, the children pilot a colorful cloud-shaped kite across floating sky gardens." },
      { episodeNumber: 10, title: "The Stegosaurus Berry Patch", premise: "In a prehistoric meadow, the children discover which berry bushes plant-eating dinosaurs love to snack on." },
      { episodeNumber: 11, title: "The Star Gazer's Broken Lens", premise: "In Ancient Greece, the children find a smooth sea-glass pebble to fix an astronomer's small stargazing telescope." },
      { episodeNumber: 12, title: "The Penguin's Ice Slide", premise: "In Antarctica, the children test different snowy slopes to find the gentlest slide for a cautious penguin chick." },
      { episodeNumber: 13, title: "The Bamboo Forest Flute", premise: "In Ancient China, the children help a playful young panda carve a hollow bamboo stem to play gentle music." },
      { episodeNumber: 14, title: "The Solar Sail's Sunny Patch", premise: "Aboard a space station, the children unfurl a golden solar sail to catch morning sunbeams." },
      { episodeNumber: 15, title: "The Butterfly Garden Clock", premise: "In a Victorian greenhouse, the children learn how flowers bloom at different times of day." },
      { episodeNumber: 16, title: "The Submarine's Bubble Song", premise: "In a miniature submarine, the children follow playful whale echoes to navigate around a coral labyrinth." },
      { episodeNumber: 17, title: "The Viking Ship's Wooden Shield", premise: "Along a Nordic fjord, the children paint a bright sun symbol on a wooden shield for a calm lake voyage." },
      { episodeNumber: 18, title: "The T-Rex's Gentle Touch", premise: "Beside a prehistoric river, the children teach a large dinosaur how to gently cradle a fallen bird's nest." },
      { episodeNumber: 19, title: "The Space Garden's Floating Tomato", premise: "In an orbital greenhouse, the children harvest weightless red cherry tomatoes floating in mid-air." },
      { episodeNumber: 20, title: "The Desert Caravan's Water Canteen", premise: "In a desert oasis, the children follow date palm shadows to locate a fresh sparkling spring." },
      { episodeNumber: 21, title: "The Medieval Castle's Feather Quill", premise: "In a grand stone castle, the children search for a shed owl feather to write a royal banquet invitation." },
      { episodeNumber: 22, title: "The Fossil Hunter's Little Brush", premise: "In a sunlit canyon, the children gently dust sandstone rocks to reveal spiral shell fossils." },
      { episodeNumber: 23, title: "The Aurora Borealis Paintbrush", premise: "In the Arctic tundra, the children watch emerald green lights swirl above a cozy wooden lodge." },
      { episodeNumber: 24, title: "The Clock Tower's Golden Gear", premise: "In a Renaissance village, the children find a small brass cog to make the village bell chime on the hour." },
      { episodeNumber: 25, title: "The Time-Travel Welcome Party", premise: "Back in their backyard, the children bring together souvenirs and friends from every era to celebrate Bobo." },
    ],
    nextEpisode: {
      episodeNumber: 2,
      title: "The Moon Robot's Missing Wheel",
      premise: "The children arrive at a Moon colony and help a small robot retrieve a wheel that has floated away in low gravity.",
      mainCharacterName: "Leo",
      scenes: [
        {
          sceneNumber: 1,
          environmentDescription: "A cozy sunlit backyard near a large leafy oak tree with a wooden fence and flowering bushes.",
          action: "Bobo the Backpack wiggles on the grass and opens a glowing starlit portal swirling with silvery moonbeams; Leo leaps forward excitedly as Mia and Tara watch in delight.",
          narrationText: "One breezy afternoon in the backyard, Bobo the Backpack gave a playful wiggle and opened a swirling starlit portal above the lawn. 'Look at all those glittering moonbeams!' cheered Leo, bouncing on his sneakers as Mia and Tara hurried closer to see.",
          cameraAngle: "establishing",
          lighting: "warm afternoon sunlight with cool blue portal glow",
          characterNames: ["Mia", "Leo", "Tara", "Bobo the Backpack"],
          sceneDetails: "Leo: leaping forward, hands up, energetic boy grin. Mia: holding notebook, cute brown bob haircut, smiling. Tara: high ponytail, hands clasped, curious. Bobo: mouth open, zipper glowing, straps vibrating.",
        },
        {
          sceneNumber: 2,
          environmentDescription: "Inside a futuristic transparent lunar biodome looking out onto bright white moon craters and starry black sky with Earth glowing in the distance.",
          action: "The children step out of the portal onto the soft grey lunar path inside the biodome, floating lightly in slow-motion bounces.",
          narrationText: "With a gentle pop, the children landed inside a giant glass moon dome overlooking vast white craters and the blue Earth high above. 'We are floating!' giggled Mia, floating two inches above the lunar path while Leo did a slow-motion astronaut jump.",
          cameraAngle: "medium",
          lighting: "bright crisp lunar sunlight filtered through glass dome, starry dark sky",
          characterNames: ["Mia", "Leo", "Tara", "Bobo the Backpack"],
          sceneDetails: "Mia: floating softly mid-air, brown bob hair, yellow shirt, jeans, notebook in hand. Leo: mid-air slow-motion leap, green shirt, cargo shorts. Tara: gentle bounce, high ponytail floating upwards, purple shirt. Bobo: hovering cheerfully near Tara.",
        },
        {
          sceneNumber: 3,
          environmentDescription: "The central plaza of the lunar biodome with futuristic silver railings and glowing plant hydroponic tubes.",
          action: "The children discover Beep the small silver moon robot wobbling on three wheels, beeping softly and pointing up at its fourth wheel floating out of reach.",
          narrationText: "A soft, worried chime echoed across the biodome plaza. Down by the silver railing, a small shiny moon robot named Beep wobbled awkwardly on three wheels, pointing a tiny mechanical claw toward its fourth wheel drifting gently near the dome ceiling.",
          cameraAngle: "medium",
          lighting: "soft clean biodome lighting with glowing turquoise hydroponic accents",
          characterNames: ["Mia", "Leo", "Tara", "Bobo the Backpack"],
          supportingEntities: ["Beep the Moon Robot: a cute friendly silver dome-headed robot with round blue sensor eyes, two jointed arms, wobbling on three small rubber wheels"],
          sceneDetails: "Beep: tilted on three wheels, one claw pointing upwards, sad blinking blue eyes. Leo: leaning down, concerned, hand on knee. Tara: studying the floating wheel thoughtfully. Mia: sketching the trajectory in her notebook. Bobo: resting near Tara.",
        },
        {
          sceneNumber: 4,
          environmentDescription: "The upper level of the lunar biodome beneath the glowing curved glass roof.",
          action: "Leo makes a high, graceful low-gravity leap into the air, reaching out with both hands to catch the drifting wheel while Mia, Tara, and Bobo cheer from below.",
          narrationText: "With a brave countdown, Leo pushed off the floor with all his might, soaring up in a soaring arc through the low gravity. 'Got it!' Leo laughed, catching the silver wheel with both hands as Mia, Tara, and Bobo cheered from the ground below.",
          cameraAngle: "medium",
          lighting: "bright starlight through curved glass ceiling with warm dome glow",
          characterNames: ["Mia", "Leo", "Tara", "Bobo the Backpack"],
          supportingEntities: ["Beep the Moon Robot: a cute friendly silver dome-headed robot with round blue sensor eyes, watching from below"],
          continuityAnchors: ["drifting silver robot wheel with yellow rim", "transparent glass dome panels overhead"],
          sceneDetails: "Leo: floating near the ceiling catching the wheel with both hands, big smile. Mia and Tara: on the ground looking up, clapping and waving. Beep: rolling on three wheels below, eyes blinking green with joy. Bobo: hopping excitedly.",
        },
        {
          sceneNumber: 5,
          environmentDescription: "The biodome plaza next to a glowing moon rover and hydroponic garden.",
          action: "Tara helps snap the wheel securely back onto Beep's axle, and the robot happily spins around in a circle with blinking green lights as the children celebrate.",
          narrationText: "Click! Tara carefully snapped the wheel back onto the axle, tightening the lug with a gentle turn. Beep spun in three joyful circles, chiming a happy song with bright green flashing lights as the four friends celebrated their moon colony triumph.",
          cameraAngle: "medium",
          lighting: "warm glowing lights from the moon plaza, cheerful celebration atmosphere",
          characterNames: ["Mia", "Leo", "Tara", "Bobo the Backpack"],
          supportingEntities: ["Beep the Moon Robot: a cute friendly silver dome-headed robot with round green glowing eyes, spinning smoothly on all four wheels"],
          continuityAnchors: ["futuristic silver railings and hydroponic plant tubes"],
          sceneDetails: "Beep: spinning smoothly on all four wheels with sparkling green lights. Tara: wiping hands with a proud smile, high ponytail. Leo: pumping fist in victory, green shirt, cargo shorts. Mia: holding notebook, big girl smile. Bobo: bouncing with a wide grin.",
        },
      ],
    },
  },

  // ==========================================
  // CONCEPT 2: Adventures Inside Everyday Objects
  // ==========================================
  {
    id: 2,
    conceptName: "Adventures Inside Everyday Objects",
    conceptSummary:
      "Every episode begins with 'Today we're going inside...'. The main characters magically enter an everyday object and discover that inside it exists a huge imaginative world with its own characters, locations, rules, and adventure.",
    formula:
      "Preschool exploration adventure starting with 'Today we're going inside...'. Connects everyday object functions to whimsical miniature worlds. 1 scene = 1 image = 1 narration clip.",
    characters: [
      {
        name: "Milo",
        description:
          "A curious and enthusiastic 5-year-old boy with wavy light-brown hair, warm hazel eyes, wearing a bright royal-blue striped t-shirt, khaki cargo shorts, and navy sneakers. Eager young boy features.",
      },
      {
        name: "Zara",
        description:
          "A creative and imaginative 5-year-old girl with curly dark-brown hair tied in two puffy space buns with pink ribbons, dark brown eyes, wearing a coral-pink t-shirt under teal denim overalls, and white sneakers. Inventive young girl features.",
      },
      {
        name: "Ben",
        description:
          "A funny and energetic 5-year-old boy with messy bright ginger-orange hair, light freckles on cheeks, wearing an orange hoodie, olive-green cotton pants, and red sneakers. Playful young boy features.",
      },
      {
        name: "Dot",
        description:
          "A tiny magical guide sprite who understands hidden worlds inside objects. A glowing pearlescent sprite with shimmering translucent butterfly wings, soft golden sparkle aura, and a cheerful friendly smile.",
      },
    ],
    environments: [
      {
        name: "Sunny Family Kitchen",
        description: "A bright modern family kitchen with warm butcher-block counters, white subway tile walls, and a tall stainless-steel refrigerator.",
      },
      {
        name: "Frosty Food Kingdom",
        description: "A magical glittering winter wonderland inside a refrigerator with crystal ice-block shelves, yogurt mountains, and an ice palace.",
      },
    ],
    season1Episodes: [
      { episodeNumber: 1, title: "Inside the Refrigerator: Frosty Food Kingdom", premise: "The children magically enter a refrigerator to help the food citizens restart the cold breeze vent before the ice palace begins to melt." },
      { episodeNumber: 2, title: "Inside the Pencil: The Graphite Bridge", premise: "The children enter a pencil to rebuild a broken graphite bridge so colorful sketches can cross to the Paper Kingdom." },
      { episodeNumber: 3, title: "Inside the Washing Machine: The Bubble Rapids", premise: "The children ride friendly sudsy bubbles down churning water slides to rescue a lost fuzzy sock." },
      { episodeNumber: 4, title: "Inside the School Bus: The Highway of Gears", premise: "Inside a toy school bus, the children help miniature traffic controllers replace a slipped engine cog." },
      { episodeNumber: 5, title: "Inside the Clock: The Pendulum Swing", premise: "Inside a grandfather clock, the children balance on a shiny brass pendulum to help the second hand keep time." },
      { episodeNumber: 6, title: "Inside the Umbrella: The Raindrop Canopy", premise: "Inside a yellow umbrella, the children guide cheerful water droplets down waterproof fabric slides." },
      { episodeNumber: 7, title: "Inside the Vacuum Cleaner: The Dust Bunny Burrow", premise: "Inside a canister vacuum, the children navigate a soft lint maze to retrieve a missing puzzle piece." },
      { episodeNumber: 8, title: "Inside the Sneaker: The Lacing Highway", premise: "Inside a red running shoe, the children thread a bright shoelace bridge across bouncy rubber canyons." },
      { episodeNumber: 9, title: "Inside the Camera: The Rainbow Prism Room", premise: "Inside an instant camera, the children align glass lenses so sunlight can paint a vivid color picture." },
      { episodeNumber: 10, title: "Inside the Backpack: The Zipper Highway", premise: "Inside a school backpack, the children ride a golden zipper carriage to help runaway crayons find their box." },
      { episodeNumber: 11, title: "Inside the Flashlight: The Glowing Filament", premise: "Inside a metal flashlight, the children wake up sleepy spark fireflies to shine through the front reflector." },
      { episodeNumber: 12, title: "Inside the Guitar: The Resonance Valley", premise: "Inside an acoustic guitar, the children hop along giant bronze strings to create warm musical vibrations." },
      { episodeNumber: 13, title: "Inside the Toaster: The Golden Crust Cliffs", premise: "Inside a chrome toaster, the children grease a sticky spring lever so breakfast toast pops up on time." },
      { episodeNumber: 14, title: "Inside the Paintbox: The Watercolor River", premise: "Inside a watercolor tin, the children mix yellow and blue pigment droplets to paint a meadow on sketch paper." },
      { episodeNumber: 15, title: "Inside the Kettle: The Whistling Steam Cloud", premise: "Inside a copper teakettle, the children direct rising steam bubbles into a joyful melody flute." },
      { episodeNumber: 16, title: "Inside the Stapler: The Silver Bridge Builders", premise: "Inside a desk stapler, the children help silver staple ants fasten important story papers together." },
      { episodeNumber: 17, title: "Inside the Magnet: The North-South Highway", premise: "Inside a horseshoe magnet, the children guide paperclip trains along invisible magnetic force lines." },
      { episodeNumber: 18, title: "Inside the Globe: The Spinning Continents", premise: "Inside a tabletop globe, the children catch gentle trade winds to fly miniature paper planes across oceans." },
      { episodeNumber: 19, title: "Inside the Thermometer: The Red Mercury Elevator", premise: "Inside a garden thermometer, the children watch warm sunshine make the crimson column rise." },
      { episodeNumber: 20, title: "Inside the Crayon Box: The Wax Sculpture City", premise: "Inside an art box, the children melt colorful wax shavings to build a rainbow welcome arch." },
      { episodeNumber: 21, title: "Inside the Hourglass: The Golden Sand Fall", premise: "Inside an hourglass, the children count smooth quartz sand grains trickling through the glass neck." },
      { episodeNumber: 22, title: "Inside the Magnifying Glass: The Giant Leaf Forest", premise: "Inside a magnifying lens, the children explore the delicate green vein pathways of a maple leaf." },
      { episodeNumber: 23, title: "Inside the Keyboard: The Bouncing Key Springs", premise: "Inside a computer keyboard, the children bounce on springy letter keys to spell out a surprise hello." },
      { episodeNumber: 24, title: "Inside the Teapot: The Herbal Brew Meadow", premise: "Inside a ceramic teapot, the children steep sweet chamomile flower heads into fragrant warm tea." },
      { episodeNumber: 25, title: "Inside the Treasure Chest: The Brass Latch Secret", premise: "Inside an antique lockbox, the children arrange antique keys to unlock an album of past memories." },
    ],
    nextEpisode: {
      episodeNumber: 1,
      title: "Inside the Refrigerator: Frosty Food Kingdom",
      premise: "The children magically enter a refrigerator to help the food citizens restart the cold breeze vent before the ice palace begins to melt.",
      mainCharacterName: "Zara",
      scenes: [
        {
          sceneNumber: 1,
          environmentDescription: "A warm, brightly lit family kitchen with wooden countertops, colorful dish towels, and a tall stainless-steel refrigerator.",
          action: "Milo, Zara, and Ben gather in the kitchen as Dot the glowing sprite hovers near the refrigerator handle, tapping it with a tiny golden wand to open a shimmering frosty portal.",
          narrationText: "Today we're going inside the kitchen refrigerator! In the sunny kitchen, Milo, Zara, and Ben watched with wonder as Dot fluttered near the tall door, tapping the handle with her golden wand until a swirl of sparkling snowflakes opened a secret doorway.",
          cameraAngle: "establishing",
          lighting: "warm morning kitchen sunlight with sparkling cold blue sparkles from the portal",
          characterNames: ["Milo", "Zara", "Ben", "Dot"],
          sceneDetails: "Dot: tiny glowing pearlescent fairy hovering mid-air, translucent wings, holding wand. Zara: creative girl, curly dark-brown hair in two space buns with pink ties, teal overalls, pointing excitedly. Milo: boy, wavy light-brown hair, blue striped t-shirt, beige shorts, eyes wide. Ben: boy, messy orange hair, freckles, orange hoodie, green pants, cheering.",
        },
        {
          sceneNumber: 2,
          environmentDescription: "The Frosty Food Kingdom inside the refrigerator: towering crystalline glass-ice shelves, giant yogurt mountains, and a majestic ice palace in the distance.",
          action: "The shrunken children arrive on a smooth shelf of glistening frost, looking around in awe at the sparkling food kingdom.",
          narrationText: "Whoosh! The children slid down a smooth frost slide and landed gently on a sparkling shelf kingdom. Above them loomed crystal icicle arches and hills of sweet vanilla yogurt, with the towering Ice Palace gleaming in the frosty distance.",
          cameraAngle: "medium",
          lighting: "sparkling icy blue and pastel frost highlights, magical winter wonderland glow",
          characterNames: ["Milo", "Zara", "Ben", "Dot"],
          sceneDetails: "Zara: standing tall, hands on hips, space buns, smiling thoughtfully. Milo: kneeling to touch the frost, wavy hair, blue shirt. Ben: sliding on the frost, orange hoodie, laughing. Dot: fluttering nearby, glowing soft gold.",
        },
        {
          sceneNumber: 3,
          environmentDescription: "A village square on the cheese shelf of the Frosty Food Kingdom, with carved cheddar houses and lettuce leaf umbrellas.",
          action: "Sir Berry, a polite strawberry knight in tiny foil armor, explains to the children that the cold breeze vent on the top shelf has stopped spinning.",
          narrationText: "A little round strawberry wearing shiny foil armor hurried forward with a polite bow. 'I am Sir Berry!' he declared with a worried tremor in his voice. 'The cold breeze vent has stopped spinning, and if the cool air doesn't return, our Ice Palace will start to melt!'",
          cameraAngle: "medium",
          lighting: "crisp frosty lighting with slight warm amber glow from cheddar buildings",
          characterNames: ["Milo", "Zara", "Ben", "Dot"],
          supportingEntities: ["Sir Berry: a plump, cheerful red strawberry wearing miniature silver foil armor and a small green leafy helmet"],
          sceneDetails: "Sir Berry: bowing politely, holding a tiny toothpick lance, worried expression. Zara: listening intently, hand to chin, teal overalls. Ben: leaning forward, orange hoodie. Milo: hands on hips, determined boy expression. Dot: hovering between them.",
        },
        {
          sceneNumber: 4,
          environmentDescription: "The top shelf mechanical vent of the refrigerator, surrounded by frost crystals and a sturdy green celery stalk.",
          action: "Zara cleverly uses a crisp celery stalk as a lever to unjam the frosty ventilation wheel, while Milo, Ben, and Sir Berry pull together on the other end.",
          narrationText: "Zara looked at the frozen vent wheel and had a brilliant idea. 'We can use this crisp celery stalk like a seesaw lever!' she announced, wedging it beneath the stuck ice crystal while Milo, Ben, and Sir Berry pulled together with all their strength.",
          cameraAngle: "medium",
          lighting: "dramatic frosty blue light with crystalline sparkles around the vent",
          characterNames: ["Milo", "Zara", "Ben", "Dot"],
          supportingEntities: ["Sir Berry: a plump red strawberry knight in foil armor, pulling alongside the children"],
          continuityAnchors: ["sturdy green celery stalk used as a lever", "frosted silver vent wheel"],
          sceneDetails: "Zara: guiding the celery lever, two space buns, determined girl smile. Milo: pulling hard on the celery, blue striped shirt. Ben: leaning back with effort, orange hoodie. Sir Berry: pulling with his tiny hands. Dot: shining bright golden light onto the ice jam.",
        },
        {
          sceneNumber: 5,
          environmentDescription: "The Frosty Food Kingdom square in front of the sparkling Ice Palace, with swirling cool snowflake breezes.",
          action: "A fresh wave of crisp blue frost swirls across the kingdom, the Ice Palace sparkles brilliantly, and the food citizens cheer as Zara, Milo, Ben, and Dot celebrate their success.",
          narrationText: "Pop! The ice jam gave way, and a magnificent rush of cold, refreshing air swept through the shelves! The Ice Palace sparkled like diamonds, and all the food citizens cheered as Zara, Milo, and Ben gave high-fives under Dot's glowing golden sparkles.",
          cameraAngle: "medium",
          lighting: "brilliant sparkling diamond frost light, joyful festive atmosphere",
          characterNames: ["Milo", "Zara", "Ben", "Dot"],
          supportingEntities: ["Sir Berry: a joyful strawberry knight waving his leaf helmet"],
          continuityAnchors: ["sparkling crystal ice palace in background"],
          sceneDetails: "Zara: waving happily, two space buns, teal overalls, bright smile. Milo: high-fiving Ben, blue shirt. Ben: jumping with joy, orange hoodie. Dot: hovering above, sprinkling magical sparkles. Sir Berry: cheering happily.",
        },
      ],
    },
  },

  // ==========================================
  // CONCEPT 3: Tiny Heroes Club
  // ==========================================
  {
    id: 3,
    conceptName: "Tiny Heroes Club",
    conceptSummary:
      "Tiny animals do not save the world; instead, they solve everyday problems that feel like huge adventures from their tiny perspective in gardens, parks, and meadows.",
    formula:
      "Preschool animal teamwork adventure focusing on ordinary human events seen as giant miniature challenges. 1 scene = 1 image = 1 narration clip.",
    characters: [
      {
        name: "Pip the Ant",
        description:
          "A brave and organized little red ant wearing a tiny bright-yellow backpack, with large dark eyes, black antennae, and six neat little ant legs. Confident and cheerful leader.",
      },
      {
        name: "Nibbles the Hamster",
        description:
          "A plump, friendly golden-brown hamster wearing round wire glasses and a miniature brown leather tool pouch, with soft cream belly fur and curious round ears.",
      },
      {
        name: "Sunny the Sparrow",
        description:
          "A bright yellow-and-brown sparrow wearing a tiny red neck scarf, with alert dark eyes, a small triangular yellow beak, and sleek feathered wings.",
      },
      {
        name: "Pebble the Turtle",
        description:
          "A calm and gentle small green box turtle with a patterned moss-green shell, round dark eyes, and a slow, thoughtful smile.",
      },
      {
        name: "Luna the Firefly",
        description:
          "A gentle glowing yellow-and-black firefly with translucent delicate wings and a soft luminescent lime-green glowing abdomen. Kind nighttime scout.",
      },
      {
        name: "Chip the Squirrel",
        description:
          "A lively reddish-brown squirrel with a fluffy curved tail, wearing a tiny acorn-cap hat, with bright curious eyes and nimble paws.",
      },
    ],
    environments: [
      {
        name: "Meadow Clubhouse",
        description: "A cozy hollow clubhouse under tangled tree roots, with a flat pebble table, mossy chairs, and tall clover stems.",
      },
      {
        name: "Park Picnic Lawn",
        description: "A sunny green park lawn with towering blades of grass, clover blossoms, and a giant red-and-white checkered blanket in the distance.",
      },
    ],
    season1Episodes: [
      { episodeNumber: 1, title: "The Ant Saves the Picnic", premise: "When a sudden gust of wind scatters picnic treats across the giant grass, Pip and the Tiny Heroes team up to rescue a rolling strawberry before it hits a puddle." },
      { episodeNumber: 2, title: "The Sparrow Helps a Lost Butterfly", premise: "Sunny spots a young butterfly with torn wings and guides her back to the sunny marigold patch." },
      { episodeNumber: 3, title: "The Hamster's Pebble Crane", premise: "Nibbles builds a twig-and-vine crane to lift a fallen stone off the ant tunnel entrance." },
      { episodeNumber: 4, title: "The Turtle's Puddle Bridge", premise: "Pebble wades into the center of a rainwater puddle so beetle friends can use his shell as a stepping stone." },
      { episodeNumber: 5, title: "The Firefly's Night Path", premise: "Luna lights up a dark hollow log to help a family of field mice find their scattered acorn stash." },
      { episodeNumber: 6, title: "The Squirrel's Acorn Relay", premise: "Chip organizes a leaf-basket relay to gather pine nuts before the first autumn drizzle." },
      { episodeNumber: 7, title: "The Great Dandelion Flight", premise: "The friends float on fluffy dandelion seeds across the meadow path to reach the sunflower grove." },
      { episodeNumber: 8, title: "The Snail's Rainy Day Ramp", premise: "The team builds a smooth wet-leaf ramp to help a gentle garden snail climb over a stone garden wall." },
      { episodeNumber: 9, title: "The Lost Shiny Button", premise: "The friends untangle green yarn to retrieve a sparkling shirt button to decorate their clubhouse door." },
      { episodeNumber: 10, title: "The Robin's Twig Nest Rescue", premise: "The friends carry sturdy dry twigs up to a low pine branch to reinforce a mother robin's nest." },
      { episodeNumber: 11, title: "The Scent Trail Mystery", premise: "Pip follows honeysuckle aroma trails through the marigold maze to find a lost bumblebee." },
      { episodeNumber: 12, title: "The Dragonfly's Dewdrop Lens", premise: "The friends balance a pristine round dewdrop on a grass blade to study tiny moss spores." },
      { episodeNumber: 13, title: "The Cricket's Evening Harmony", premise: "The friends help a shy young cricket find his rhythm for the meadow twilight chorus." },
      { episodeNumber: 14, title: "The Watermelon Slice Mountain", premise: "The team scales a juicy pink watermelon wedge to help worker ants carry sweet seeds home." },
      { episodeNumber: 15, title: "The Pinecone Fortress", premise: "The friends roll giant pinecones to shelter a cluster of ladybugs from a windy afternoon." },
      { episodeNumber: 16, title: "The Caterpillar's Cozy Sleeping Bag", premise: "The team folds a soft autumn leaf to tuck a sleepy caterpillar in for its long winter nap." },
      { episodeNumber: 17, title: "The Windmill Flower", premise: "The friends assemble a spinning pinwheel from dried petals to keep a playful puppy away from the patch." },
      { episodeNumber: 18, title: "The Spider's Silken Trampoline", premise: "The team asks a friendly orb weaver to spin a soft silk landing net below a tall mushroom ledge." },
      { episodeNumber: 19, title: "The Bee's Nectar Relay", premise: "The friends place bright daisy petals along the path to guide bumblebees to the sweetest clover." },
      { episodeNumber: 20, title: "The Puddle Sailboat", premise: "The friends rig a dry maple leaf and twig mast to sail a family of ladybugs across a miniature puddle." },
      { episodeNumber: 21, title: "The Sunbeam Sundial", premise: "The team arranges small white pebbles in a circle around a pine needle to tell when snack time arrives." },
      { episodeNumber: 22, title: "The Mushroom Umbrella Parade", premise: "The friends march through a warm summer shower holding tiny toadstool caps as umbrellas." },
      { episodeNumber: 23, title: "The Earthworm's Tunnel Guide", premise: "The team helps a confused earthworm navigate around a buried river stone into soft compost." },
      { episodeNumber: 24, title: "The Frosted Clover Frosting", premise: "The friends admire the first delicate frost crystals on meadow clover and share warm acorn tea." },
      { episodeNumber: 25, title: "The Tiny Heroes Grand Feast", premise: "The friends celebrate a year of teamwork with a banquet of sunflower seeds, blackberries, and clover honey." },
    ],
    nextEpisode: {
      episodeNumber: 1,
      title: "The Ant Saves the Picnic",
      premise: "When a sudden gust of wind scatters picnic treats across the giant grass, Pip and the Tiny Heroes team up to rescue a rolling strawberry before it hits a puddle.",
      mainCharacterName: "Pip the Ant",
      scenes: [
        {
          sceneNumber: 1,
          environmentDescription: "Inside the cozy Meadow Clubhouse built under tangled tree roots, with a flat river pebble table and tall clover walls.",
          action: "Pip the Ant stands on a smooth grey pebble holding a blade of grass like a map, giving a morning briefing to Nibbles the Hamster, Sunny the Sparrow, and Pebble the Turtle.",
          narrationText: "In the shade of the grand oak tree, morning sunlight filtered through the clover leaves into the Meadow Clubhouse. Pip the Ant stood tall on a polished pebble, holding a green grass blade like a map as Nibbles, Sunny, and Pebble listened to the morning plan.",
          cameraAngle: "establishing",
          lighting: "soft golden morning sunlight filtering through tall green clover stems",
          characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow", "Pebble the Turtle"],
          sceneDetails: "Pip: tiny red ant standing on two hind legs, yellow backpack, holding grass blade, confident posture. Nibbles: plump golden hamster with round glasses and tool pouch, sitting attentively. Sunny: yellow-and-brown sparrow with red neck scarf, perched on a twig. Pebble: small green turtle with mossy shell, gentle smile.",
        },
        {
          sceneNumber: 2,
          environmentDescription: "The edge of a bright green park lawn with a giant red-and-white checkered picnic blanket in the distance.",
          action: "A sudden gust of wind rolls a giant ripe red strawberry off the checkered blanket and down a slope of tall grass blades toward a muddy puddle.",
          narrationText: "Whoosh! A playful summer gust of wind swept across the park, rolling a giant, glistening red strawberry off the checkered picnic blanket. Down the grassy hill it tumbled, heading straight for a muddy puddle below!",
          cameraAngle: "medium",
          lighting: "bright sunny midday light with breezy swaying grass shadows",
          characterNames: ["Pip the Ant", "Sunny the Sparrow"],
          supportingEntities: ["Giant Strawberry: a giant ripe red strawberry with green leafy stem rolling down the grass slope"],
          continuityAnchors: ["red-and-white checkered picnic blanket in background", "muddy puddle at the foot of the slope"],
          sceneDetails: "Sunny: hovering in the air with wings spread, red scarf fluttering, looking down with wide alert eyes. Pip: running along a clover leaf, pointing toward the rolling strawberry, yellow backpack visible.",
        },
        {
          sceneNumber: 3,
          environmentDescription: "Among the towering blades of clover and dandelions near the edge of the muddy puddle.",
          action: "Sunny flies overhead calling out the strawberry's path while Pip leads Nibbles down a mossy path towards the edge of the puddle.",
          narrationText: "From high in the air, Sunny fluttered her wings and chirped the strawberry's speed. 'It's rolling fast toward the mud!' she called down. Pip adjusted his tiny yellow backpack and urged Nibbles forward through the clover forest.",
          cameraAngle: "medium",
          lighting: "bright daylight with soft dappled green foliage shadows",
          characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow"],
          supportingEntities: ["Giant Strawberry: a giant ripe red strawberry tumbling toward the water's edge"],
          continuityAnchors: ["red-and-white checkered blanket in distance", "muddy puddle reflection"],
          sceneDetails: "Pip: running forward with antennae forward, yellow backpack. Nibbles: scurrying alongside, round glasses, reaching into his tool pouch. Sunny: flying overhead, signaling with one wing.",
        },
        {
          sceneNumber: 4,
          environmentDescription: "The muddy bank at the foot of the grass hill, with a large fallen brown oak leaf.",
          action: "Nibbles quickly wedges a sturdy fallen oak leaf into the soft earth while Pip helps anchor the stem, creating a gentle ramp that stops the rolling strawberry safely.",
          narrationText: "Working like a flash, Nibbles pulled a sturdy fallen oak leaf from his pouch and wedged it firmly into the soft ground. Pip grabbed the stem with all six legs to anchor it tight, and with a soft thud, the giant strawberry rolled up the ramp and came to a safe stop!",
          cameraAngle: "close",
          lighting: "warm golden afternoon sunlight sparkling on the strawberry seeds",
          characterNames: ["Pip the Ant", "Nibbles the Hamster"],
          supportingEntities: ["Giant Strawberry: giant red strawberry resting safely against the leaf ramp"],
          continuityAnchors: ["sturdy fallen oak leaf ramp", "muddy puddle rim just inches away"],
          sceneDetails: "Pip: holding the leaf stem with all legs, yellow backpack, grinning bravely. Nibbles: leaning his shoulder against the leaf ramp, glasses askew with a proud smile. Giant strawberry safely stopped on the leaf.",
        },
        {
          sceneNumber: 5,
          environmentDescription: "Back on the sunny red-and-white checkered picnic blanket, surrounded by sweet summer clover.",
          action: "The Tiny Heroes celebrate together beside the saved strawberry on the clean picnic blanket, smiling, cheering, and high-fiving in the warm sun.",
          narrationText: "The strawberry was saved! Back on the sunny red-and-white blanket, Pip, Nibbles, Sunny, and Pebble gathered around the sweet fruit, sharing cheerful high-fives and happy chirps. Another big day for the Tiny Heroes Club!",
          cameraAngle: "medium",
          lighting: "warm glowing late afternoon sunlight, warm cheerful celebration",
          characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow", "Pebble the Turtle"],
          supportingEntities: ["Giant Strawberry: pristine red strawberry resting on the checkered blanket"],
          continuityAnchors: ["red-and-white checkered picnic blanket", "clover flowers"],
          sceneDetails: "Pip: standing tall on a clover leaf, arms raised in victory, yellow backpack. Nibbles: waving, round glasses, big hamster smile. Sunny: perched on the strawberry stem, wings fluttering. Pebble: smiling serenely on the blanket.",
        },
      ],
    },
  },
];

export async function runConceptTest(conceptConfig: ConceptTestConfig, options: { onlyKeyArt?: boolean; maxScenes?: number } = {}) {
  assertLegacyImageFlowOptIn(
    "generateConceptTestSet.ts",
    "historical concept key-art and scene-image generation",
  );
  const seriesState = new SeriesState();
  console.log(`\n===============================================================`);
  console.log(`🚀 STARTING CONCEPT ${conceptConfig.id}: "${conceptConfig.conceptName}"`);
  console.log(`===============================================================`);

  try {
    // 1. Get or create series
    console.log(`\n[Step 1] Registering series in Turso DB...`);
    const seriesId = await seriesState.getOrCreateSeries(
      conceptConfig.conceptName,
      conceptConfig.characters,
      conceptConfig.environments,
      conceptConfig.formula
    );
    console.log(`✅ Series ID: ${seriesId} for "${conceptConfig.conceptName}"`);

    // 2. Bulk insert Season 1 episode list (25 episodes) if empty
    console.log(`\n[Step 2] Ensuring 25-episode Season 1 list in episodes table...`);
    await seriesState.bulkInsertEpisodesIfEmpty(seriesId, conceptConfig.season1Episodes);
    console.log(`✅ Season 1 episodes checked / seeded.`);

    // 3. Ensure Character Sheets for all main characters
    console.log(`\n[Step 3] Ensuring Character Sheets for all ${conceptConfig.characters.length} characters...`);
    const charTool = buildCharacterSheetTool(seriesState);
    for (const char of conceptConfig.characters) {
      console.log(`- Ensuring sheet for: ${char.name}`);
      const sheetRes = await (charTool as any).func({
        seriesId,
        characterName: char.name,
        characterDescription: char.description,
      });
      const parsedSheet = JSON.parse(sheetRes);
      console.log(`  ✓ ${char.name}: status=${parsedSheet.status}`);
    }

    // 4. Generate Series Key Art
    console.log(`\n[Step 4] Generating Series Key Art with presence & gender validation...`);
    const seriesKeyArtTool = buildSeriesKeyArtTool(seriesState);
    const seriesKeyArtRes = await (seriesKeyArtTool as any).func({
      seriesId,
      conceptName: conceptConfig.conceptName,
      conceptSummary: conceptConfig.conceptSummary,
      characterNames: conceptConfig.characters.map((c) => c.name),
    });
    const parsedSeriesKeyArt = JSON.parse(seriesKeyArtRes);
    console.log(`✅ Series Key Art generated: ${parsedSeriesKeyArt.path} (status: ${parsedSeriesKeyArt.status})`);

    // 5. Generate Episode Key Art
    const ep = conceptConfig.nextEpisode;
    console.log(`\n[Step 5] Generating Episode ${ep.episodeNumber} Key Art ("${ep.title}")...`);
    const episodeKeyArtTool = buildEpisodeKeyArtTool(seriesState);
    const episodeKeyArtRes = await (episodeKeyArtTool as any).func({
      seriesId,
      episodeNumber: ep.episodeNumber,
      conceptName: conceptConfig.conceptName,
      episodeTitle: ep.title,
      episodePremise: ep.premise,
      mainCharacterName: ep.mainCharacterName,
    });
    const parsedEpisodeKeyArt = JSON.parse(episodeKeyArtRes);
    console.log(`✅ Episode Key Art generated: ${parsedEpisodeKeyArt.path} (status: ${parsedEpisodeKeyArt.status})`);

    if (options.onlyKeyArt) {
      console.log(`Skipping scene images as requested (--only-key-art).`);
      return;
    }

    // 6. Generate 5 Scene Images for the Episode
    console.log(`\n[Step 6] Generating 5 Scene Images for Episode ${ep.episodeNumber} with QA...`);
    const sceneTool = buildSceneImageTool(seriesState);
    const sceneLimit = options.maxScenes ?? 5;
    const sceneResults: string[] = [];

    for (let i = 0; i < Math.min(sceneLimit, ep.scenes.length); i++) {
      const scene = ep.scenes[i];
      console.log(`\n--- [Concept ${conceptConfig.id}] Generating Scene ${scene.sceneNumber} ---`);
      const sceneRes = await (sceneTool as any).func({
        seriesId,
        episodeNumber: ep.episodeNumber,
        sceneNumber: scene.sceneNumber,
        environmentDescription: scene.environmentDescription,
        action: scene.action,
        narrationText: scene.narrationText,
        cameraAngle: scene.cameraAngle,
        lighting: scene.lighting,
        characterNames: scene.characterNames,
        characterVisuals: scene.characterVisuals,
        supportingEntities: scene.supportingEntities,
        continuityAnchors: scene.continuityAnchors,
        sceneDetails: scene.sceneDetails,
      });
      const parsedScene = JSON.parse(sceneRes);
      console.log(`  ✓ Scene ${scene.sceneNumber}: path=${parsedScene.path} status=${parsedScene.status}`);
      sceneResults.push(parsedScene.path);
    }

    console.log(`\n🎉 CONCEPT ${conceptConfig.id} ("${conceptConfig.conceptName}") COMPLETED SUCCESSFULLY!`);
    console.log(`- Series Key Art: ${parsedSeriesKeyArt.path}`);
    console.log(`- Episode Key Art: ${parsedEpisodeKeyArt.path}`);
    console.log(`- Scenes (${sceneResults.length}):`);
    sceneResults.forEach((p, idx) => console.log(`  Scene ${idx + 1}: ${p}`));
  } finally {
    await seriesState.close();
  }
}

import { CONCEPTS_BATCH_2 } from "./conceptDataBatch2.js";
import { CONCEPTS_BATCH_3 } from "./conceptDataBatch3.js";

const ALL_CONCEPTS: ConceptTestConfig[] = [...CONCEPTS, ...CONCEPTS_BATCH_2, ...CONCEPTS_BATCH_3];

async function main() {
  const args = process.argv.slice(2);
  const conceptArg = args.find((a) => a.startsWith("--concept="));
  const conceptVal = conceptArg ? conceptArg.split("=")[1] : args[args.indexOf("--concept") + 1];
  const onlyKeyArt = args.includes("--only-key-art");

  let targetConcepts = ALL_CONCEPTS;
  if (conceptVal && conceptVal !== "all") {
    const ids = conceptVal.split(",").map((v) => parseInt(v.trim(), 10));
    targetConcepts = ALL_CONCEPTS.filter((c) => ids.includes(c.id));
    if (targetConcepts.length === 0) {
      console.error(`Unknown concept(s): ${conceptVal}. Expected IDs from 1 to 8, comma-separated list, or 'all'.`);
      process.exit(1);
    }
  }

  console.log(`Running generation for ${targetConcepts.length} concept(s)...`);
  for (const concept of targetConcepts) {
    await runConceptTest(concept, { onlyKeyArt });
  }
  console.log(`\n✨ ALL TEST RUNS COMPLETE!`);
}

// If executed directly from CLI
if (process.argv[1] && process.argv[1].includes("generateConceptTestSet")) {
  main().catch((err) => {
    console.error("Fatal error in test runner:", err);
    process.exit(1);
  });
}
