import type { CharacterDef, EnvironmentDef } from "../src/state/seriesState.js";

export interface SceneDef {
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

export interface ConceptTestConfig {
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

export const CONCEPTS_BATCH_2: ConceptTestConfig[] = [
  // ==========================================
  // CONCEPT 4: What If Toys Came Alive at Midnight?
  // ==========================================
  {
    id: 4,
    conceptName: "What If Toys Came Alive at Midnight?",
    conceptSummary:
      "Every night after children fall asleep, their toys secretly come alive. While the children sleep, the toys explore the house, solve small problems, help forgotten toys, and complete secret missions before morning. The world feels magical and vast from the toys' tiny perspective.",
    formula:
      "Preschool nighttime toy adventure. Bedroom objects feel monumental; toys combine unique skills to solve kindhearted problems and return safely before dawn. 1 scene = 1 image = 1 narration clip.",
    characters: [
      {
        name: "Toby the Teddy Bear",
        description:
          "A kind and brave vintage plush teddy bear with warm honey-brown plush fur, dark brown stitched nose and paw pads, wearing a festive red velvet bow tie. The gentle, reliable leader of the toys.",
      },
      {
        name: "Pip the Toy Robot",
        description:
          "A clever and cheerful retro tin toy robot with bright silver and turquoise casing, yellow square eyes, two flexible spring arms with friendly clamp hands, and a small antenna on his head.",
      },
      {
        name: "Lulu the Doll",
        description:
          "A caring and imaginative porcelain-and-cloth rag doll with porcelain-smooth rosy cheeks, painted blue eyes, curly blonde yarn hair tied with purple satin ribbons, wearing a soft lavender lace dress and pink ballet slippers.",
      },
      {
        name: "Zoom the Toy Car",
        description:
          "An energetic and cheerful bright-yellow die-cast toy racing car with bold orange lightning-bolt decals, friendly cartoon windshield eyes, chrome front bumper, and glossy black rubber wheels.",
      },
      {
        name: "Buttons the Plush Bunny",
        description:
          "A sweet and timid small cream-colored plush bunny rabbit with long floppy ears lined in pastel pink, stitched black button eyes, a little pink nose, and a fluffy white round tail.",
      },
      {
        name: "Mr. Tick-Tock",
        description:
          "An antique wind-up brass clockwork owl toy with polished golden gears visible through glass panels, glowing amber eyes, and a shiny brass wind-up key on his back.",
      },
    ],
    environments: [
      {
        name: "Moonlit Bedroom Floor",
        description: "A cozy children's bedroom at midnight, bathed in gentle silver moonlight, with a soft blue cloud-pattern rug, wooden toy chest, and tall bed draped in cozy quilts.",
      },
      {
        name: "Living Room Rug Wilderness",
        description: "A vast nighttime living room with towering armchair wooden legs, deep wool carpet plains, and tall mountains of folded laundry baskets.",
      },
    ],
    season1Episodes: [
      { episodeNumber: 1, title: "The Missing Sock", premise: "A tiny doll sock disappears right before Lulu's bedtime tea party. Toby, Pip, Buttons, and Zoom search under the bed and behind furniture to find it." },
      { episodeNumber: 2, title: "The Broken Kite Tail", premise: "A toy kite brought home from the park has a torn ribbon tail. The toys work together using yarn and glue to fix it before sunrise." },
      { episodeNumber: 3, title: "The Lost Train Track", premise: "The wooden train cannot complete its loop around the rug because a curved track piece is wedged beneath the toy chest." },
      { episodeNumber: 4, title: "The Floating Soap Bubble Voyage", premise: "In the bathroom, the toys navigate gentle floating soap bubbles to retrieve a dropped plastic duckling from the edge of the tub." },
      { episodeNumber: 5, title: "The Midnight Tea Party Spill", premise: "When wooden fruit blocks tumble across the dollhouse dining table, the toys stack them into a colorful fruit tower." },
      { episodeNumber: 6, title: "The Battery Run-Down Rescue", premise: "Pip's flashlight battery starts to dim, so the friends roll a wind-up generator across the rug to recharge his beacon." },
      { episodeNumber: 7, title: "The Marble Maze Mountain", premise: "A shiny glass marble rolls into a maze of building blocks, and Zoom must steer through narrow tunnels to guide it out." },
      { episodeNumber: 8, title: "The Slippery Banister Slide", premise: "The toys build a soft pillow landing pad at the bottom of the hallway banister for a thrilling nighttime relay." },
      { episodeNumber: 9, title: "The Clockwork Key Hunt", premise: "Mr. Tick-Tock's brass winding key slips under the dresser, and Buttons uses her long floppy ears to fish it out safely." },
      { episodeNumber: 10, title: "The Crayon Box Rainbow Bridge", premise: "The toys arrange colorful wax crayons into an arching bridge to cross over a wide gap between two rug cushions." },
      { episodeNumber: 11, title: "The Dust Bunny Hide-and-Seek", premise: "The toys befriend a timid, fluffy dust bunny under the bed and help it find a safe, cozy corner." },
      { episodeNumber: 12, title: "The Bedpost Lighthouse", premise: "Pip climbs to the top of the wooden bedpost and shines his chest light to guide lost toys back to the rug center." },
      { episodeNumber: 13, title: "The Bookshelf High Climb", premise: "Lulu and Toby climb soft stacked books to retrieve a picture drawing that fell behind the reading shelf." },
      { episodeNumber: 14, title: "The Feather Pillow Snowstorm", premise: "A loose pillow seam creates a harmless flurry of white down feathers, and the toys build miniature feather snowmen." },
      { episodeNumber: 15, title: "The Squeaky Floorboard Mystery", premise: "The toys discover which floorboard squeaks and carefully place a soft wool coaster over it so they don't wake the sleeping child." },
      { episodeNumber: 16, title: "The Wind-Up Mouse Caravan", premise: "A family of wind-up mice need help steering their cardboard carriage across the kitchen linoleum floor." },
      { episodeNumber: 17, title: "The Kitchen Tile Ice Rink", premise: "The toys glide smoothly across polished kitchen tiles on felt pads, holding a joyful nighttime dance party." },
      { episodeNumber: 18, title: "The Blanket Fort Expedition", premise: "The friends explore a tunnel inside a fallen duvet blanket fort, lighting their way with glow-in-the-dark stars." },
      { episodeNumber: 19, title: "The Lost Pajama Button", premise: "A bright yellow button pops off a nightgown, and the toys roll it back across the room to rest safely on the nightstand." },
      { episodeNumber: 20, title: "The Music Box Ballerina's Turn", premise: "The wind-up music box gets stuck, and Pip carefully oils the tiny brass spindle so the ballerina can spin freely." },
      { episodeNumber: 21, title: "The Shadow Puppet Surprise", premise: "Using flashlight beams and their hands and ears, the toys create funny animal silhouettes on the bedroom wall." },
      { episodeNumber: 22, title: "The Cardboard Castle Moat", premise: "The toys build a toy castle out of cereal boxes, complete with a drawbridge made of popsicle sticks." },
      { episodeNumber: 23, title: "The Dollhouse Attic Discovery", premise: "In the dollhouse attic, the toys find an old miniature music record and play a soft lullaby." },
      { episodeNumber: 24, title: "The Stuffed Puppy's Sweet Lullaby", premise: "A new puppy plushie feels lonely on its first night, so Toby and Buttons tuck it in with a warm fleece scrap." },
      { episodeNumber: 25, title: "The Sunrise Sprint Home", premise: "As pink morning light touches the window blinds, the toys work together in a hilarious synchronized rush to freeze in their exact spots." },
    ],
    nextEpisode: {
      episodeNumber: 1,
      title: "The Missing Sock",
      premise: "A tiny doll sock disappears right before Lulu's bedtime tea party. Toby, Pip, Buttons, and Zoom launch a nighttime expedition across the bedroom floor, discovering the sock has become a cozy sleeping bag for a tiny lost toy mouse.",
      mainCharacterName: "Toby the Teddy Bear",
      scenes: [
        {
          sceneNumber: 1,
          environmentDescription: "A cozy children's bedroom at midnight, bathed in gentle silver moonlight from the window, with soft rugs and a wooden toy chest.",
          action: "As the wall clock strikes twelve, Toby the Teddy Bear blinks his stitched eyes, sits up on the blue cloud rug, and stretches his furry arms with a cheerful yawn as the other toys begin to stir.",
          narrationText: "Tick-tock, chime! As the bedroom wall clock struck twelve, silver moonlight poured across the floor. Toby the Teddy Bear gave a big fluffy stretch, his button nose twitching with delight. 'Midnight!' whispered Toby happily. 'Time for our adventures to begin!'",
          cameraAngle: "establishing",
          lighting: "magical silver moonlight with soft indigo bedroom shadows",
          characterNames: ["Toby the Teddy Bear", "Pip the Toy Robot", "Lulu the Doll", "Zoom the Toy Car", "Buttons the Plush Bunny"],
          sceneDetails: "Toby: sitting up on the cloud rug, red bow tie, honey-brown fur, stretching with a happy smile. Pip: eyes glowing yellow, standing up. Lulu: sitting on a soft pillow in her lavender dress. Zoom: headlights blinking softly. Buttons: long floppy ears perking up.",
        },
        {
          sceneNumber: 2,
          environmentDescription: "In front of the pastel wooden dollhouse on the bedroom rug.",
          action: "Lulu the Doll looks anxiously through her tiny wardrobe drawers, holding up one striped doll sock and showing Toby and Buttons that the matching sock is gone.",
          narrationText: "Over by the wooden dollhouse, Lulu the Doll smoothed her lavender lace skirt with a worried sigh. 'Oh dear!' she cried softly, holding up a single tiny striped sock. 'My favorite bedtime sock is missing, and our midnight tea party is about to start!'",
          cameraAngle: "medium",
          lighting: "warm golden fairy-light glow from inside the dollhouse mixed with moonlit shadows",
          characterNames: ["Toby the Teddy Bear", "Lulu the Doll", "Buttons the Plush Bunny"],
          sceneDetails: "Lulu: holding one tiny pink-and-white striped sock, porcelain face with worried painted blue eyes, curly blonde yarn hair. Toby: patting her shoulder reassuringly with his plush paw. Buttons: wiggling her pink nose with sympathetic round eyes.",
        },
        {
          sceneNumber: 3,
          environmentDescription: "The floor beneath the tall wooden bed, looking like a cavernous hall of bedposts and tucked slippers.",
          action: "Pip turns on his chest flashlight beam, illuminating a glowing path beneath the bed frame, while Zoom drives ahead on his rubber wheels to scout between the slippers.",
          narrationText: "'Don't worry, Lulu! Team Toys is on the case!' announced Toby bravely. Pip clicked on his bright chest spotlight, sweeping a warm yellow beam beneath the giant bed while Zoom the yellow racecar zoomed ahead, tires humming over the soft carpet.",
          cameraAngle: "medium",
          lighting: "dramatic warm flashlight beam cutting through the cool blue shadowy space beneath the bed",
          characterNames: ["Toby the Teddy Bear", "Pip the Toy Robot", "Zoom the Toy Car"],
          sceneDetails: "Pip: chest spotlight shining forward, yellow square eyes, spring arms raised. Zoom: yellow racecar speeding ahead with gleaming headlights. Toby: walking forward on plush feet, red bow tie neat, leading with confidence.",
        },
        {
          sceneNumber: 4,
          environmentDescription: "Behind a tall wicker laundry basket near the corner of the bedroom wardrobe.",
          action: "Buttons the Plush Bunny peeks behind the woven wicker basket and gasps softly with joy, finding the missing striped sock curled up with a tiny fuzzy toy mouse sleeping peacefully inside.",
          narrationText: "Buttons crept behind the giant wicker laundry basket and gasped in delight. There, nestled right inside Lulu's soft striped sock, was a tiny fuzzy toy mouse fast asleep, snoring with tiny squeaks like a purring kitten.",
          cameraAngle: "close",
          lighting: "soft moonlight filtering through wicker patterns, cozy warm ambient glow",
          characterNames: ["Buttons the Plush Bunny", "Toby the Teddy Bear"],
          supportingEntities: ["Pipqueak the Toy Mouse: a tiny grey velvet toy mouse with pink stitched ears, sleeping curled up inside the striped sock"],
          continuityAnchors: ["pink-and-white striped doll sock", "wicker laundry basket"],
          sceneDetails: "Buttons: paws clasped to her chest, long floppy ears drooped gently, face glowing with tenderness. Toby: peeking over the basket with a warm smile. Pipqueak: tucked snug inside the sock sleeping peacefully.",
        },
        {
          sceneNumber: 5,
          environmentDescription: "The cozy center of the blue cloud rug in front of the dollhouse.",
          action: "Lulu lovingly folds a warm fleece ribbon blanket for the little mouse to sleep in, and all the toys share a gentle midnight toast with wooden teacups under the moonlight.",
          narrationText: "'Keep the sock, little friend!' whispered Lulu kindly, tucking a soft ribbon blanket over the sleeping mouse. The toys gathered around the tea table, raising their painted cups in a silent toast to teamwork, kindness, and midnight friendship.",
          cameraAngle: "medium",
          lighting: "warm golden dollhouse light and serene silver moonlight",
          characterNames: ["Toby the Teddy Bear", "Pip the Toy Robot", "Lulu the Doll", "Zoom the Toy Car", "Buttons the Plush Bunny"],
          supportingEntities: ["Pipqueak the Toy Mouse: resting happily in a tiny matchbox bed nearby"],
          continuityAnchors: ["pink-and-white striped doll sock", "wooden dollhouse tea table"],
          sceneDetails: "Lulu: smiling with relief, lavender dress, pouring imaginary tea. Toby: raising a tiny blue wooden teacup with a proud smile. Pip: clinking clamps with Zoom. Buttons: gently petting the tiny mouse. Warm toy camaraderie.",
        },
      ],
    },
  },

  // ==========================================
  // CONCEPT 5: The Talking Library
  // ==========================================
  {
    id: 5,
    conceptName: "The Talking Library",
    conceptSummary:
      "A magical library contains books whose characters can come alive. When the children open a special book, its world spills into the library. The children must help the characters solve their problem and safely return them to their story.",
    formula:
      "Preschool literary wonder adventure. A mysterious magical library book opens with whimsical phenomena; the children use teamwork and clues to solve the storybook character's dilemma and escort them home. 1 scene = 1 image = 1 narration clip.",
    characters: [
      {
        name: "Nora",
        description:
          "A curious and imaginative 5-year-old girl with wavy chin-length auburn-red hair, bright hazel eyes, wearing an emerald-green knit cardigan over a cream cotton dress, white lace-trimmed ankle socks, and yellow mary-jane shoes. Feminine young girl features.",
      },
      {
        name: "Arjun",
        description:
          "An adventurous and enthusiastic 5-year-old boy with neat side-parted jet-black hair, warm brown eyes, wearing a bright orange polo shirt, navy-blue cargo shorts, and royal-blue sneakers. Energetic young boy features.",
      },
      {
        name: "Lily",
        description:
          "A thoughtful and observant 5-year-old girl with dark brown hair styled in two low braids tied with yellow ribbons, wearing round purple spectacles, a sunny yellow pleated dress, and brown ankle boots. Studious young girl features.",
      },
      {
        name: "Pagey",
        description:
          "A tiny magical living bookmark made of glowing golden-edged parchment paper, with cute expressive blue eyes, tiny paper arms, a fluttery scarlet ribbon tail, and the ability to fly gracefully between books.",
      },
      {
        name: "Grand Librarian Mira",
        description:
          "A kind, wise, and dignified elderly woman librarian with silver-grey hair styled in an elegant neat bun, warm wrinkled smile, wearing round tortoiseshell glasses, a turquoise woolen shawl over a dark navy librarian dress.",
      },
    ],
    environments: [
      {
        name: "Grand Magical Library",
        description: "A majestic circular library with towering oak bookshelves reaching toward a vaulted stained-glass dome, rolling brass ladders, velvet reading chairs, and glowing magical dust motes in the air.",
      },
      {
        name: "Shipwreck Cove Book Spillway",
        description: "A corner of the library transformed by storybook magic into a tropical cove with golden sand drifting across the parquet floor, small palm fronds, and turquoise water ripples.",
      },
    ],
    season1Episodes: [
      { episodeNumber: 1, title: "The Pirate Who Lost His Map", premise: "A pirate jumps out of a book but cannot return because his treasure map is missing. The children follow clues across the library to recover it." },
      { episodeNumber: 2, title: "The Dinosaur Between the Pages", premise: "A baby dinosaur accidentally wanders out of a prehistoric book and becomes lost among the high library shelves." },
      { episodeNumber: 3, title: "The Wizard's Runaway Spark", premise: "A friendly apprentice wizard drops a glowing magic spark that turns book illustrations into floating 3D paper figures." },
      { episodeNumber: 4, title: "The Robot Who Wanted to Paint", premise: "A geometric metal robot rolls out of a sci-fi novel, eager to learn how to mix watercolors with the children." },
      { episodeNumber: 5, title: "The Mermaid's Whispering Conch", premise: "A mermaid peeks from an ocean book and needs help hearing her pod's song over the sound of library whispers." },
      { episodeNumber: 6, title: "The Fairy Queen's Dewdrop Crown", premise: "A tiny forest fairy misplaces her dewdrop crown among the library's botanical encyclopedias." },
      { episodeNumber: 7, title: "The Astronaut's Lost Star Compass", premise: "An astronaut explorer floats out of an astronomy atlas looking for a brass astrolabe to navigate back to Mars." },
      { episodeNumber: 8, title: "The Egyptian Kitten's Sun Amulet", premise: "A golden temple kitten slips out of a papyrus scroll and chases papyrus butterflies around the card catalog." },
      { episodeNumber: 9, title: "The Knight's Squeaky Armor", premise: "A noble knight in shiny plate armor cannot sneak past a sleeping story dragon because his knee joints keep squeaking." },
      { episodeNumber: 10, title: "The Flying Carpet's Loose Thread", premise: "A magical miniature carpet unravels near the reference desk, and the children help weave colorful thread back into its fringe." },
      { episodeNumber: 11, title: "The Baker Bear's Missing Honey", premise: "A plump storybook bear searches cookbook aisles to find sweet wildflower nectar for his morning honey buns." },
      { episodeNumber: 12, title: "The Cloud Giant's Feather Pillow", premise: "A gentle cloud giant drops his fluffy white pillow through the pages of a fairy tale right onto the library carpet." },
      { episodeNumber: 13, title: "The Origami Crane's First Flight", premise: "A folded paper crane unfolds its wings and learns how to catch thermal drafts from the library skylight." },
      { episodeNumber: 14, title: "The Roman Chariot's Golden Wheel", premise: "A miniature wooden chariot needs a new golden axle pin to roll back into its historical scroll." },
      { episodeNumber: 15, title: "The Deep Sea Pearl Riddle", premise: "The children solve three rhyming riddles to open a giant story oyster and retrieve a lost luminous pearl." },
      { episodeNumber: 16, title: "The Garden Gnome's Sunflower Umbrella", premise: "A cheerful garden gnome wants to bring a real library sunflower back to shelter his ladybug neighbors." },
      { episodeNumber: 17, title: "The Detective Badger's Magnifying Glass", premise: "A badger detective wearing a tweed cape misplaces his magnifying glass behind the mystery novel section." },
      { episodeNumber: 18, title: "The Snow Queen's Warm Scarf", premise: "The children knit a soft woolen scarf to help a lonely frost queen feel warm friendship in her snowy kingdom." },
      { episodeNumber: 19, title: "The Little Red Train's Whistle", premise: "A toy steam locomotive chugs across the library tables, blowing cheerful steam puffs as the children build track." },
      { episodeNumber: 20, title: "The Castle Cook's Magic Soup", premise: "The children gather story herbs from botanical prints to help a royal chef season a banquet broth." },
      { episodeNumber: 21, title: "The Moon Rabbit's Pounded Rice Cake", premise: "A folkloric rabbit from an Asian myth book searches for sweet powdered sugar to dust moon cakes." },
      { episodeNumber: 22, title: "The Steampunk Owl's Brass Feather", premise: "The children polish a mechanical owl's clockwork wing so it can glide back into its Victorian sky chapter." },
      { episodeNumber: 23, title: "The Rainforest Toucan's Colorful Song", premise: "A colorful toucan loses its vibrant melody, and the children play musical chime notes on desk bells to help it sing." },
      { episodeNumber: 24, title: "The Viking Longship's Dragon Head", premise: "The children help attach a carved wooden figurehead to a storyboat before it embarks down the library fjord." },
      { episodeNumber: 25, title: "The Grand Library Story Jubilee", premise: "All the storybook friends from the season gather in the grand rotunda for a joyful storytelling festival with Grand Librarian Mira." },
    ],
    nextEpisode: {
      episodeNumber: 1,
      title: "The Pirate Who Lost His Map",
      premise: "Captain Barnaby the pirate leaps out of a storm-tossed storybook but cannot return because his treasure map is missing. Nora, Arjun, Lily, and Pagey follow clues across the library to recover it.",
      mainCharacterName: "Nora",
      scenes: [
        {
          sceneNumber: 1,
          environmentDescription: "Inside the grand circular library with towering oak shelves, warm afternoon sunbeams streaming through a stained-glass dome, and reading tables.",
          action: "Nora, Arjun, and Lily sit around a polished oak reading table while Pagey the bookmark flutters overhead; suddenly a large blue leather book begins to tremble and glow with golden sparks.",
          narrationText: "It was a peaceful afternoon in the Grand Library when the magic began. Nora, Arjun, and Lily watched in amazement as Pagey fluttered his scarlet ribbon tail, circling a thick blue leather book that began to shudder and glow with glittering golden sparkles!",
          cameraAngle: "establishing",
          lighting: "warm golden sunbeams with glittering magical blue-and-gold sparkles",
          characterNames: ["Nora", "Arjun", "Lily", "Pagey"],
          sceneDetails: "Nora: wavy auburn hair, emerald cardigan, leaning forward with wide curious eyes. Arjun: orange polo, smiling excitedly, hands on table. Lily: purple glasses, yellow dress, tilting head thoughtfully. Pagey: glowing golden bookmark hovering above book.",
        },
        {
          sceneNumber: 2,
          environmentDescription: "Beside the reading table where tropical sand and ocean shells have magically spilled out onto the library parquet floor.",
          action: "The book pops open and Captain Barnaby, a friendly round pirate in a red coat and tricorn hat, steps out onto the floor, clutching his sea boots and looking dismayed.",
          narrationText: "With a splash of sea-spray and a shower of golden sand, the cover flipped open! Out stepped Captain Barnaby, a jolly pirate in a crimson coat and feathered tricorn hat. 'Shiver me timbers!' he bellowed with a worried frown. 'My treasure map has flown away, and without it I can't sail home!'",
          cameraAngle: "medium",
          lighting: "warm library lighting with shimmering ocean reflections on the floor",
          characterNames: ["Nora", "Arjun", "Lily", "Pagey"],
          supportingEntities: ["Captain Barnaby: a friendly round pirate with curly brown beard, red captain's coat with gold buttons, feathered tricorn hat, and black sea boots"],
          continuityAnchors: ["open glowing blue leather pirate book", "scattered golden beach sand on floor"],
          sceneDetails: "Captain Barnaby: scratching his beard under his hat, looking bewildered. Nora: kneeling down to touch the sand, smiling reassuringly. Arjun: pointing eagerly toward the shelves. Lily: examining a clue footprint. Pagey: floating near Barnaby's shoulder.",
        },
        {
          sceneNumber: 3,
          environmentDescription: "Between two towering oak bookshelves with ornate brass rolling ladders.",
          action: "Pagey flies high up near the top shelf, pointing with his paper wing to a rolled parchment map tied with a red ribbon resting on a high bookshelf ledge.",
          narrationText: "Pagey soared high into the air like a tiny golden bird, weaving between the leather-bound volumes. 'There it is!' gasped Lily, adjusting her purple glasses as Pagey hovered beside a rolled parchment map perched on the very top shelf ledge.",
          cameraAngle: "medium",
          lighting: "dappled sunlight filtering between tall bookshelves",
          characterNames: ["Nora", "Arjun", "Lily", "Pagey"],
          supportingEntities: ["Captain Barnaby: looking up with his hands on his hips, cheering"],
          continuityAnchors: ["rolled parchment treasure map tied with red ribbon", "brass rolling ladder"],
          sceneDetails: "Pagey: hovering beside the rolled map at the top shelf. Lily: pointing up with both hands, braids bouncing, yellow dress. Nora: waving at Pagey. Arjun: gripping the rolling ladder. Barnaby: mouth open in cheerful pirate surprise.",
        },
        {
          sceneNumber: 4,
          environmentDescription: "At the base of the tall oak bookshelf with the rolling brass ladder.",
          action: "Arjun and Barnaby hold the sturdy wooden ladder steady while Nora carefully climbs up the steps and safely retrieves the parchment map with a beaming smile.",
          narrationText: "'Steady does it!' called Arjun, bracing the ladder with both hands as Captain Barnaby anchored the base with his sturdy sea boots. Nora climbed step by step, reached out her hand, and plucked the treasure map safely from the shelf!",
          cameraAngle: "medium",
          lighting: "bright sunbeam illuminating Nora on the ladder",
          characterNames: ["Nora", "Arjun", "Lily", "Pagey"],
          supportingEntities: ["Captain Barnaby: holding the ladder base, smiling proudly"],
          continuityAnchors: ["rolled parchment treasure map", "tall brass-and-wood rolling ladder"],
          sceneDetails: "Nora: mid-ladder reaching up and holding the rolled parchment, emerald cardigan, happy grin. Arjun: holding the ladder rails firmly, orange polo shirt. Lily: clapping below. Barnaby: thumbs up. Pagey: dancing in mid-air.",
        },
        {
          sceneNumber: 5,
          environmentDescription: "Beside the open glowing storybook on the library table, with Grand Librarian Mira watching kindly from the doorway.",
          action: "Captain Barnaby joyfully takes his map, salutes the children with his feathered hat, and steps back through the glowing blue portal pages into his pirate ship world as Nora, Arjun, and Lily wave goodbye.",
          narrationText: "'Thank ye, young navigators!' cheered Captain Barnaby, tucking the map beneath his arm and bowing with a sweep of his hat. He stepped into the swirling blue light of the book, and with a gentle flutter of pages, the story closed peacefully as Grand Librarian Mira nodded with a knowing smile.",
          cameraAngle: "medium",
          lighting: "warm golden library atmosphere with soft fading blue portal glow",
          characterNames: ["Nora", "Arjun", "Lily", "Pagey", "Grand Librarian Mira"],
          supportingEntities: ["Captain Barnaby: waving hat as he steps through the glowing portal pages"],
          continuityAnchors: ["blue leather storybook closing on table"],
          sceneDetails: "Barnaby: stepping into swirling blue book glow, waving hat. Nora: waving happily, emerald cardigan. Arjun: smiling with hands on hips. Lily: smiling through purple spectacles. Pagey: resting gently on Nora's shoulder. Mira: standing in archway with turquoise shawl and gentle proud smile.",
        },
      ],
    },
  },

  // ==========================================
  // CONCEPT 6: Planet of Emotions
  // ==========================================
  {
    id: 6,
    conceptName: "Planet of Emotions",
    conceptSummary:
      "A group of young explorers travels through space to magical planets, where each planet represents a different emotion. Every planet is shaped and affected by its main feeling, helping preschool children understand feelings through adventure, empathy, and storytelling.",
    formula:
      "Preschool space emotional adventure. Explores feeling through whimsical alien environments and gentle problem-solving without moralizing or lecturing. 1 scene = 1 image = 1 narration clip.",
    characters: [
      {
        name: "Nova",
        description:
          "A curious and enthusiastic 5-year-old girl with chestnut-brown hair tied in a high spiky ponytail with a bright purple streak, hazel eyes, wearing a white-and-cyan space explorer jumpsuit, yellow boots, and a wrist hologram comms band. Feminine young girl features.",
      },
      {
        name: "Max",
        description:
          "An energetic and brave 5-year-old boy with tousled dark brown hair, expressive dark eyes, wearing an orange-and-white space explorer jumpsuit, grey utility belt, and red sneakers. Energetic young boy features.",
      },
      {
        name: "Ivy",
        description:
          "A calm, thoughtful, and empathetic 5-year-old girl with sleek straight jet-black hair held by a light-blue headband, warm brown eyes, wearing a teal-and-silver space suit and white boots. Mindful young girl features.",
      },
      {
        name: "Orbit",
        description:
          "A friendly spherical floating robot spaceship companion with smooth glossy white enamel casing, twin mini antennae ears, round glowing blue expressive visor eyes, and two little magnetic hover pads.",
      },
    ],
    environments: [
      {
        name: "Star-Hop Spaceship Cockpit",
        description: "A bright, cozy spaceship cockpit with colorful touch controls, soft cushion swivel seats, and a giant curved glass observation dome showing swirling pink and violet nebulae.",
      },
      {
        name: "Planet Anger - Caldera Meadow",
        description: "A whimsical alien planet landscape of glowing reddish-pink clay soil, harmless puffy violet smoke geysers, warm bubbling soda-springs, and friendly puffing mini-volcanoes.",
      },
    ],
    season1Episodes: [
      { episodeNumber: 1, title: "The Angry Little Volcano", premise: "The children visit Planet Anger, where a small baby volcano keeps puffing hot smoke when a rock puzzle won't fit. They discover gentle ways to pause and calm down." },
      { episodeNumber: 2, title: "The Shadow Behind the Star Tree", premise: "On Planet Fear, a shy creature is too afraid to leave its glowing tree because it believes a giant shadow is chasing it." },
      { episodeNumber: 3, title: "The Bouncing Balloon Blossom", premise: "On Planet Happiness, bouncy flower petals carry the explorers skyward, teaching them that sharing joy makes it bounce even higher." },
      { episodeNumber: 4, title: "The Color-Changing Camellia", premise: "On Planet Jealousy, flowers turn green with envy when other blossoms open, until they learn each color has its own beauty." },
      { episodeNumber: 5, title: "The Gentle Raincloud Friend", premise: "On Planet Sadness, a little blue cloud needs a friendly shoulder to lean on so its gentle rain shower can nurture a sweet garden." },
      { episodeNumber: 6, title: "The Whispering Stone Bridge", premise: "On Planet Kindness, stepping stones only link across a sparkling river when the friends speak warm and encouraging words." },
      { episodeNumber: 7, title: "The Jack-in-the-Box Crater", premise: "On Planet Surprise, harmless popping springs and confetti puffs surprise the explorers and show how unexpected moments can be fun." },
      { episodeNumber: 8, title: "The Flutter-Wing Whirlwind", premise: "On Planet Worry, butterflies flap nervously until the explorers teach them to hold hands and take deep belly breaths together." },
      { episodeNumber: 9, title: "The Brave Little Comet Ride", premise: "On Planet Courage, a small shooting star learns that being brave means trying your best even when your tummy feels fluttery." },
      { episodeNumber: 10, title: "The Stillwater Lotus Lake", premise: "On Planet Calm, rippling water smoothens into a clear glass mirror when the children sit quietly and listen to bellflowers." },
      { episodeNumber: 11, title: "The Giggling Geyser Valley", premise: "On Planet Joy, bubbling springs erupt with warm citrus bubbles whenever the explorers tell a funny riddle." },
      { episodeNumber: 12, title: "The Tangled Vine of Frustration", premise: "On Planet Frustration, knotted vines tighten when pulled in anger, but loosen smoothly when untangled step by step." },
      { episodeNumber: 13, title: "The Glowing Shield of Confidence", premise: "On Planet Pride, a young crystal turtle discovers that practicing a skill makes its crystalline shell shine brightly." },
      { episodeNumber: 14, title: "The Warm Blanket Nebula", premise: "On Planet Comfort, soft velvet moss wraps around weary travelers to help them recharge their energetic spirits." },
      { episodeNumber: 15, title: "The Hidden Burrow of Shyness", premise: "On Planet Shyness, a timid creature peeks from behind a velvet leaf, slowly gaining confidence through gentle smiles." },
      { episodeNumber: 16, title: "The Sparkle Fountain of Gratitude", premise: "On Planet Gratitude, sparkling water flows upward toward the stars whenever someone says a heartfelt thank you." },
      { episodeNumber: 17, title: "The Heavy Pebble Path", premise: "On Planet Forgiveness, heavy stones carried in backpacks become weightless as feather fluffs when misunderstandings are apologized for." },
      { episodeNumber: 18, title: "The Bouncy Spring of Excitement", premise: "On Planet Excitement, bouncy springs propel the explorers across trampoline hills, learning to pace their high energy." },
      { episodeNumber: 19, title: "The Gray Fog of Loneliness", premise: "On Planet Loneliness, chilly gray mists dissolve into golden sunshine as the explorers invite a solitary alien into their game." },
      { episodeNumber: 20, title: "The Sweet Blossom of Patience", premise: "On Planet Patience, a giant sugar flower opens slowly petal by petal, showing that the most magical surprises take time." },
      { episodeNumber: 21, title: "The Red Puff-Cloud Reset", premise: "The explorers return to Planet Anger to help a friendly lava dragon count backwards from five to cool its sizzling scales." },
      { episodeNumber: 22, title: "The Lantern of Curiosity", premise: "On Planet Wonder, glowing floating lanterns lead the explorers down mysterious crystal tunnels of discovery." },
      { episodeNumber: 23, title: "The Gentle Breeze of Peace", premise: "On Planet Serenity, soft warm winds carry melodic wind-chime music through fields of lavender reeds." },
      { episodeNumber: 24, title: "The Dancing Rainbow Aurora", premise: "On Planet Love, ribbons of vibrant colored light dance across the night sky, welcoming all creatures just as they are." },
      { episodeNumber: 25, title: "The Star Harmony Gathering", premise: "Friends from all the emotion planets join hands at the cosmic observatory for a magnificent festival of feelings." },
    ],
    nextEpisode: {
      episodeNumber: 1,
      title: "The Angry Little Volcano",
      premise: "The children visit Planet Anger, where a small baby volcano keeps puffing hot smoke when a rock puzzle won't fit. They discover gentle ways to pause and calm down.",
      mainCharacterName: "Nova",
      scenes: [
        {
          sceneNumber: 1,
          environmentDescription: "Inside the Star-Hop spaceship cockpit looking through the curved glass dome down at the swirling crimson, orange, and purple clouds of Planet Anger.",
          action: "Nova points enthusiastically through the cockpit glass as Orbit beeps with spinning antenna lights, while Max and Ivy lean forward from their seats to prepare for landing.",
          narrationText: "Far out in the galaxy, the Star-Hop spaceship glided toward a warm, glowing world wrapped in swirl of fiery crimson clouds. 'There it is — Planet Anger!' exclaimed Nova, her purple ponytail bouncing as Orbit chimed with cheerful spinning blue sensor eyes.",
          cameraAngle: "establishing",
          lighting: "warm glowing cockpit lights with rich red-and-purple cosmic glow from outside",
          characterNames: ["Nova", "Max", "Ivy", "Orbit"],
          sceneDetails: "Nova: pointing forward, purple-streaked ponytail, white-and-cyan suit, yellow boots, smiling. Max: leaning on console, orange jumpsuit, eager expression. Ivy: calm smile, teal suit, blue headband. Orbit: floating between them with spinning antennae.",
        },
        {
          sceneNumber: 2,
          environmentDescription: "On the reddish-pink clay plains of Planet Anger, dotted with warm bubbling soda pools and harmless violet smoke vents.",
          action: "The children step out of the lander and spot Puffy, a small baby volcano with round cartoon eyes and a little stone mouth, stomping its base and puffing hot red smoke rings.",
          narrationText: "Step, hop! The children landed on the soft pink clay plain. Right in front of them stood Puffy, a knee-high baby volcano with big watery eyes and rosy stone cheeks. Puffy puffed angry red smoke rings into the air, stomping his rocky base with frustration!",
          cameraAngle: "medium",
          lighting: "warm afternoon crimson sunlight with vibrant purple smoke puffs",
          characterNames: ["Nova", "Max", "Ivy", "Orbit"],
          supportingEntities: ["Puffy the Volcano: a small, cute knee-high baby volcano with big expressive blue cartoon eyes, rosy stone cheeks, puffing harmless red smoke rings from his top crater"],
          continuityAnchors: ["Star-Hop spaceship lander on the ridge", "soft reddish-pink clay soil"],
          sceneDetails: "Puffy: crater smoking red, arms of stone crossed, frustrated pout. Max: stepping back with wide eyes. Nova: crouching down gently with open hands. Ivy: tilting head empathetically. Orbit: hovering low with yellow concerned eyes.",
        },
        {
          sceneNumber: 3,
          environmentDescription: "Beside a colorful stone puzzle archway near a warm bubbling mineral fountain.",
          action: "Max and Nova inspect the puzzle archway and see that a heavy triangular red stone keeps rolling out of place and falling onto the grass, which made Puffy lose his temper.",
          narrationText: "'Look,' said Max, pointing to a tumbled pile of shiny ruby stones beside a stone arch. 'Puffy is trying to build a welcome arch, but that pointy top rock keeps tumbling off!' Every time the stone fell, Puffy's crater sizzled with louder pops of hot smoke.",
          cameraAngle: "medium",
          lighting: "warm golden-red glow reflecting off polished ruby stones",
          characterNames: ["Nova", "Max", "Ivy", "Orbit"],
          supportingEntities: ["Puffy the Volcano: puffing smoke rings, looking ready to burst with steam"],
          continuityAnchors: ["partially built stone archway", "smooth ruby puzzle stones"],
          sceneDetails: "Max: holding a triangular red stone, studying the arch. Nova: pointing to the rounded base. Puffy: cheeks bulging with steam, smoke turning dark red. Ivy: stepping beside Puffy, speaking softly.",
        },
        {
          sceneNumber: 4,
          environmentDescription: "In the meadow under a gentle shade tree made of cool purple crystal leaves.",
          action: "Ivy kneels beside Puffy and leads everyone in taking slow, deep calming breaths, and as Puffy breathes in and out, his smoke turns from angry red to soft calming lavender bubbles.",
          narrationText: "Ivy gently knelt beside Puffy and placed a soft hand on his warm stone side. 'When we feel a big rumble inside, it helps to pause,' Ivy whispered with a soothing smile. 'Let's take three deep balloon breaths together.' Breathe in... and breathe out! Slowly, Puffy's sizzling smoke turned into floating lavender bubbles!",
          cameraAngle: "close",
          lighting: "soothing lavender and pastel pink ambient light, peaceful and calm",
          characterNames: ["Nova", "Max", "Ivy", "Orbit"],
          supportingEntities: ["Puffy the Volcano: taking a deep breath with closed eyes, his crater puffing gentle lavender heart bubbles"],
          continuityAnchors: ["crystal shade tree", "floating lavender bubbles"],
          sceneDetails: "Ivy: hands on heart, peaceful closed-eye smile, teal suit. Puffy: smiling with relief, cool lavender bubbles floating upward from his crater. Nova and Max: breathing along with hands on bellies. Orbit: glowing soft cyan.",
        },
        {
          sceneNumber: 5,
          environmentDescription: "The completed colorful stone archway on the calderas meadow, with Planet Anger's dual moons rising in the sky.",
          action: "Working together calmly, Nova and Max help Puffy place the key stone securely onto the archway; the archway sparkles with golden light, and Puffy dances happily in a circle.",
          narrationText: "With calm hands and clear minds, Nova and Max guided the ruby stone into the groove. Click! It locked perfectly in place! The archway glowed with glittering starlight, and Puffy spun with joyful giggles, puffing rainbow bubbles high into the twilight sky!",
          cameraAngle: "medium",
          lighting: "magical twilight sky with glowing stone archway and dual alien moons",
          characterNames: ["Nova", "Max", "Ivy", "Orbit"],
          supportingEntities: ["Puffy the Volcano: dancing happily, puffing colorful rainbow bubbles, wide cheerful grin"],
          continuityAnchors: ["completed glowing stone archway", "dual moons in sky"],
          sceneDetails: "Puffy: jumping in mid-air with joy, rainbow bubbles swirling. Nova: high-fiving Ivy with a huge smile. Max: cheering with fist pumped. Orbit: doing a celebratory loop-de-loop. A triumphant victory of emotional understanding.",
        },
      ],
    },
  },
];
