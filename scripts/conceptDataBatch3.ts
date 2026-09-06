import type { CharacterDef, EnvironmentDef } from "../src/state/seriesState.js";
import type { SceneDef, ConceptTestConfig } from "./conceptDataBatch2.js";

export const CONCEPTS_BATCH_3: ConceptTestConfig[] = [
  // ==========================================
  // CONCEPT 7: Detective Cookie
  // ==========================================
  {
    id: 7,
    conceptName: "Detective Cookie",
    conceptSummary:
      "Detective Cookie is a clever cookie who secretly solves strange mysteries before someone discovers him and eats him. Every episode begins with a mystery where something has disappeared, been mixed up, moved, or mysteriously changed. Everyday places like kitchens, bedrooms, and gardens feel huge and adventurous from Cookie's tiny perspective.",
    formula:
      "Preschool/early elementary mystery adventure. Whimsical investigation with visual clues, gentle suspense, humorous close calls with being eaten, and teamwork to solve the puzzle before morning or breakfast. 1 scene = 1 image = 1 narration clip.",
    characters: [
      {
        name: "Detective Cookie",
        description:
          "A clever, confident, and slightly dramatic gingerbread detective cookie with a golden-baked crust, white icing smile, dark chocolate chip buttons, wearing a tiny houndstooth tweed deerstalker detective hat and a miniature tan trench coat, holding a tiny brass magnifying glass. Always alert and cautious about hungry humans.",
      },
      {
        name: "Crumb",
        description:
          "Detective Cookie's tiny cookie sidekick, a small bite-sized round golden sugar cookie with sparkling sugar crystals on top, wide curious cartoon eyes, a friendly crumbly smile, wearing a miniature red bowtie. Funny, easily distracted, and accidentally discovers useful clues.",
      },
      {
        name: "Sprinkle",
        description:
          "A smart and observant candy investigator shaped like a tall polished rainbow sugar sprinkle with thin round purple spectacles, a tiny notepad made of a postage stamp, and a miniature peppermint-striped candy cane walking stick. Notices patterns and small details.",
      },
      {
        name: "Captain Kettle",
        description:
          "A wise antique polished copper stovetop kettle with a curved spout, friendly steam eyes, and an ornate brass lid. Sits on the kitchen stove, knowing everything that happens in the house and whistling clues in rhyming riddles.",
      },
    ],
    environments: [
      {
        name: "The Giant Kitchen Counter",
        description:
          "A vast polished marble kitchen counter from a tiny cookie perspective, lined with towering cereal boxes, giant fruit bowls, and sparkling clean glass jars.",
      },
      {
        name: "The Midnight Dining Room Table",
        description:
          "A grand polished oak dining table beneath a soft pendant lamp, scattered with festive tablecloth runners, party confetti, and giant porcelain teacups.",
      },
      {
        name: "Under the Wooden Kitchen Stools",
        description:
          "A quiet shadowy grove beneath tall carved wooden barstools on a linoleum floor, where dust motes drift and dropped crumbs form miniature landmarks.",
      },
      {
        name: "The Stovetop Hearth",
        description:
          "The clean black ceramic stovetop where Captain Kettle rests, warm and inviting with cozy reflections in his copper belly.",
      },
    ],
    season1Episodes: [
      { episodeNumber: 1, title: "The Case of the Missing Birthday Candles", premise: "Just before a birthday party, all the candles disappear from the cake; Detective Cookie discovers a tiny toy dragon borrowed them to light a dark dollhouse." },
      { episodeNumber: 2, title: "The Mystery of the Mixed-Up Socks", premise: "Every sock in the laundry basket has been mismatched by a playful puppy building a soft sleeping tunnel." },
      { episodeNumber: 3, title: "The Vanishing Sugar Bowl Spoon", premise: "The antique silver teaspoon disappears from the breakfast tray; Cookie tracks sugar dust to an origami swan's nest." },
      { episodeNumber: 4, title: "The Squeaky Floorboard Suspect", premise: "A nighttime squeak keeps threatening to wake the family cat; Cookie deduces a rolling wooden marble is triggering it." },
      { episodeNumber: 5, title: "The Case of the Ticking Teacup", premise: "An empty porcelain teacup on the high shelf is ticking rhythmically like a clock; Cookie discovers a wind-up beetle trapped underneath." },
      { episodeNumber: 6, title: "The Secret of the Cinnamon Trail", premise: "Swirling trails of aromatic cinnamon dust lead across the baker's flour bin to a family of ginger mice building a spice hill." },
      { episodeNumber: 7, title: "The Riddle of the Floating Soap Bubbles", premise: "Bubbles drift across the dark kitchen with tiny letters inside; Cookie decodes Captain Kettle's morning greeting." },
      { episodeNumber: 8, title: "The Missing Refrigerator Magnet Letters", premise: "Colorful plastic alphabet letters vanish from the fridge door, spelling out a hidden code under the stove." },
      { episodeNumber: 9, title: "The Case of the Sleepy Alarm Clock", premise: "The baker's mechanical wind-up clock stopped at 3 AM because a ribbon was gently tangled in its bell hammer." },
      { episodeNumber: 10, title: "The Giant Footprint on the Flour Board", premise: "A massive three-toed footprint in white flour looks terrifying until Cookie proves it was made by a three-pronged pastry fork." },
      { episodeNumber: 11, title: "The Mystery of the Runaway Rolling Pin", premise: "A wooden rolling pin rolled across the pantry floor on its own; Cookie finds dried peas acting as miniature ball bearings." },
      { episodeNumber: 12, title: "The Case of the Disappearing Sprinkles", premise: "Rainbow sprinkles vanish one color at a time; Sprinkle analyzes the pattern to find a color-sorting clockwork toy robot." },
      { episodeNumber: 13, title: "The Secret of the Chandelier Shadow", premise: "A spooky monster silhouette on the wall turns out to be a single celery stalk casting a dramatic shadow from the nightlight." },
      { episodeNumber: 14, title: "The Case of the Cold Toaster", premise: "The toaster lever won't stay down because a forgotten wooden clothespeg is bracing the spring." },
      { episodeNumber: 15, title: "The Clue in the Cookie Jar", premise: "A mysterious key lies at the bottom of the tall porcelain cookie jar; Cookie and Crumb build a licorice rope ladder to retrieve it." },
      { episodeNumber: 16, title: "The Mystery of the Whistling Keyhole", premise: "A spooky nighttime whistle from the pantry door is solved when Cookie discovers a tiny paper flyer caught in the draft." },
      { episodeNumber: 17, title: "The Case of the Jam Jar Fingerprints", premise: "Sticky red strawberry prints on the recipe book lead Cookie to test whether the culprit was the kitchen mouse or a leaky jelly dropper." },
      { episodeNumber: 18, title: "The Case of the Missing Pepper Mill Top", premise: "A brass screw from the pepper mill rolled under the fruit bowl; Crumb uses a magnet to fish it out." },
      { episodeNumber: 19, title: "The Secret of the Breadbox Echo", premise: "Strange hollow echoes inside the metal breadbox turn out to be a cricket rehearsing a midnight lullaby." },
      { episodeNumber: 20, title: "The Mystery of the Floating Teabag", premise: "A chamomile teabag bobs mysteriously in a mug; Cookie discovers a baby rubber duck using it as a cozy raft." },
      { episodeNumber: 21, title: "The Case of the Spilled Milk Lake", premise: "A puddle of milk threatens to trap the cookie team; Cookie navigates across floating wooden toothpicks like rafts." },
      { episodeNumber: 22, title: "The Case of the Mismatched Recipe Card", premise: "Grandma's secret pie recipe card had its steps swapped; Cookie analyzes flour smudges to restore the correct order." },
      { episodeNumber: 23, title: "The Clue of the Dancing Napkin", premise: "A folded linen napkin flutters across the counter; Cookie uncovers an electric fan that turns on with a gentle kitchen breeze." },
      { episodeNumber: 24, title: "The Secret of the Honey Pot Maze", premise: "Sticky honey droplets lead through a maze of spice jars to a lost honeybee looking for the garden window." },
      { episodeNumber: 25, title: "The Case of the Grand Breakfast Bell", premise: "The family's breakfast bell rings five minutes early; Cookie solves the mystery just as human footsteps approach, diving safely into his tin box." },
    ],
    nextEpisode: {
      episodeNumber: 1,
      title: "The Case of the Missing Birthday Candles",
      premise:
        "Just before a child's birthday party, all six colorful spiral candles vanish from the birthday cake. Detective Cookie, Crumb, and Sprinkle follow tiny drops of melted wax across the kitchen counter, interview Captain Kettle, and discover a tiny plush dragon borrowed them to read in a dark dollhouse.",
      mainCharacterName: "Detective Cookie",
      scenes: [
        {
          sceneNumber: 1,
          environmentDescription:
            "Detective Cookie's miniature headquarters inside an overturned porcelain teacup on the giant kitchen counter, lit by a tiny birthday candle stub.",
          action:
            "Detective Cookie peers through his magnifying glass at an urgent note written on a paper muffin liner, while Crumb points excitedly and Sprinkle takes notes with a tiny peppermint pencil.",
          narrationText:
            "Inside an overturned porcelain teacup on the midnight kitchen counter, Detective Cookie adjusted his tiny tweed deerstalker hat. 'Great crumbs!' he gasped, studying an urgent note written on a ruffled muffin liner. 'The party starts at dawn, and all six birthday candles have vanished from the cake!'",
          cameraAngle: "medium",
          lighting: "warm golden candlelight with soft kitchen shadows",
          characterNames: ["Detective Cookie", "Crumb", "Sprinkle"],
          characterVisuals: [
            { name: "Detective Cookie", visualForm: "gingerbread detective cookie with deerstalker hat, tan coat, magnifying glass", humanoidAllowed: true },
            { name: "Crumb", visualForm: "tiny round sugar cookie with red bowtie and sugar crystals", humanoidAllowed: true },
            { name: "Sprinkle", visualForm: "tall rainbow candy sprinkle with round purple glasses and peppermint stick", humanoidAllowed: true },
          ],
          supportingEntities: [],
          continuityAnchors: ["Detective Cookie's miniature desk made of a wooden checker piece inside the porcelain teacup."],
          sceneDetails:
            "Detective Cookie: serious, squinting through magnifying glass, golden baked crust, tan trench coat. Crumb: wide round eyes, bouncing with excitement, red bowtie. Sprinkle: taking notes with tiny pencil, purple glasses. High curiosity and teamwork.",
        },
        {
          sceneNumber: 2,
          environmentDescription:
            "Beside a giant frosted two-tier strawberry birthday cake on the wooden dining table, surrounded by paper party hats.",
          action:
            "Detective Cookie inspects six empty holes in the pink cake frosting with his magnifying glass, discovering tiny rainbow wax droplets leading toward the edge of the table.",
          narrationText:
            "Cookie, Crumb, and Sprinkle hurried over to the giant strawberry cake. Six empty little craters dotted the creamy pink frosting! 'Aha!' cried Cookie, peering closely through his glass. 'Look at these tiny rainbow droplets — the culprit left a wax trail leading right off the table!'",
          cameraAngle: "medium",
          lighting: "bright dining room chandelier glow",
          characterNames: ["Detective Cookie", "Crumb", "Sprinkle"],
          characterVisuals: [
            { name: "Detective Cookie", visualForm: "gingerbread detective cookie with deerstalker hat, tan coat, magnifying glass", humanoidAllowed: true },
            { name: "Crumb", visualForm: "tiny round sugar cookie with red bowtie and sugar crystals", humanoidAllowed: true },
            { name: "Sprinkle", visualForm: "tall rainbow candy sprinkle with round purple glasses and peppermint stick", humanoidAllowed: true },
          ],
          supportingEntities: [],
          continuityAnchors: ["Giant pink frosted birthday cake with strawberry garnishes."],
          sceneDetails:
            "Detective Cookie: leaning over frosting, magnifying glass held up, focused expression. Crumb: pointing at rainbow wax drops on tablecloth. Sprinkle: measuring droplet spacing with candy cane ruler. Investigating with keen observation.",
        },
        {
          sceneNumber: 3,
          environmentDescription:
            "The stovetop hearth beside Captain Kettle, an antique polished copper kettle reflecting warm yellow kitchen light.",
          action:
            "Detective Cookie and Crumb interview Captain Kettle, who releases a gentle puff of steam and whistles a riddle pointing toward the toy dollhouse in the living room.",
          narrationText:
            "The wax trail led past the stove where Captain Kettle rested in polished copper glory. Cookie tipped his tweed hat respectfully. 'Captain, did you see who took the candles?' With a cheerful whistle and a spiral of steam, Captain Kettle chuckled, 'Search where dolls sleep and play, where a tiny fire needs a ray!'",
          cameraAngle: "medium",
          lighting: "warm copper reflections and soft white steam puffs",
          characterNames: ["Detective Cookie", "Crumb", "Captain Kettle"],
          characterVisuals: [
            { name: "Detective Cookie", visualForm: "gingerbread detective cookie with deerstalker hat, tan coat, magnifying glass", humanoidAllowed: true },
            { name: "Crumb", visualForm: "tiny round sugar cookie with red bowtie and sugar crystals", humanoidAllowed: true },
            { name: "Captain Kettle", visualForm: "antique polished copper kettle with steam eyes and brass lid", humanoidAllowed: false },
          ],
          supportingEntities: [],
          continuityAnchors: ["Polished copper body of Captain Kettle with gentle steam rising."],
          sceneDetails:
            "Detective Cookie: looking up with hands on trench coat lapels, listening intently. Crumb: clapping paws at steam whistle. Captain Kettle: friendly curved spout, gentle steam swirling upward. Whimsical riddle revelation.",
        },
        {
          sceneNumber: 4,
          environmentDescription:
            "Inside the miniature living room of a wooden Victorian toy dollhouse on the living room rug.",
          action:
            "Detective Cookie peeks into the dollhouse window to find Ignis, a tiny purple plush toy dragon, reading a picture book illuminated by the six missing colorful birthday candles.",
          narrationText:
            "Following the riddle, Cookie crept to the wooden dollhouse. Inside sat Ignis, a cuddly purple toy dragon the size of a teacup! Ignis wasn't being naughty — he was just trying to read his favorite bedtime storybook, using the six colorful candles to light up the dark little room!",
          cameraAngle: "medium",
          lighting: "warm colorful glow from six lit birthday candles inside the miniature dollhouse",
          characterNames: ["Detective Cookie", "Crumb", "Sprinkle"],
          characterVisuals: [
            { name: "Detective Cookie", visualForm: "gingerbread detective cookie with deerstalker hat, tan coat, magnifying glass", humanoidAllowed: true },
            { name: "Crumb", visualForm: "tiny round sugar cookie with red bowtie and sugar crystals", humanoidAllowed: true },
            { name: "Sprinkle", visualForm: "tall rainbow candy sprinkle with round purple glasses and peppermint stick", humanoidAllowed: true },
          ],
          supportingEntities: [
            "Ignis the Toy Dragon: a tiny cuddly purple plush toy dragon with turquoise felt wings, soft yellow horns, and big gentle cartoon eyes, sitting cross-legged reading a miniature book.",
          ],
          continuityAnchors: ["Six colorful spiral birthday candles standing on tiny saucers in the dollhouse."],
          sceneDetails:
            "Detective Cookie: smiling warmly through dollhouse doorway with hands open in understanding. Ignis: looking up with shy, apologetic round eyes, hugging his storybook. Crumb and Sprinkle: peeking with delight. Heartwarming discovery.",
        },
        {
          sceneNumber: 5,
          environmentDescription:
            "The kitchen cake table at pre-dawn as the six candles stand returned safely on the birthday cake, while Ignis reads happily with a safe glowing fairy light.",
          action:
            "The candles are returned to the cake; Detective Cookie hands Ignis a safe glowing LED fairy light, and the cookie detectives celebrate together before sunrise.",
          narrationText:
            "'Mystery solved!' cheered Cookie softly, trading the candles for a safe battery-powered fairy light for Ignis. With the candles returned to the cake and Ignis reading happily in his cozy glow, Detective Cookie tipped his hat. 'Another delicious case closed — before breakfast!'",
          cameraAngle: "establishing",
          lighting: "soft pastel morning twilight through kitchen curtains",
          characterNames: ["Detective Cookie", "Crumb", "Sprinkle"],
          characterVisuals: [
            { name: "Detective Cookie", visualForm: "gingerbread detective cookie with deerstalker hat, tan coat, magnifying glass", humanoidAllowed: true },
            { name: "Crumb", visualForm: "tiny round sugar cookie with red bowtie and sugar crystals", humanoidAllowed: true },
            { name: "Sprinkle", visualForm: "tall rainbow candy sprinkle with round purple glasses and peppermint stick", humanoidAllowed: true },
          ],
          supportingEntities: [
            "Ignis the Toy Dragon: holding a glowing yellow fairy-light bulb, smiling happily beside the dollhouse.",
          ],
          continuityAnchors: ["All six colorful spiral candles restored on top of the pink birthday cake."],
          sceneDetails:
            "Detective Cookie: tipping his tweed deerstalker with a victorious smile, coat fluttering slightly. Crumb: jumping in mid-air with joy. Sprinkle: checking off the case file with a flourish. Ignis: waving happily with his warm glowing light. Triumphant, safe, peaceful resolution.",
        },
      ],
    },
  },

  // ==========================================
  // CONCEPT 8: The Dream Repair Shop
  // ==========================================
  {
    id: 8,
    conceptName: "The Dream Repair Shop",
    conceptSummary:
      "Somewhere between waking and sleeping exists a magical shop where broken dreams are repaired. When a child's dream loses something, becomes tangled, or goes wrong, the dream repair team enters the dream world, discovers what is broken, and gently repairs it before morning with magical tools like rainbow thread, star glue, and moonlight paint.",
    formula:
      "Gentle preschool bedtime adventure. Dream problems connect to soothing emotions (worry, fear of the dark, loneliness); the team listens, understands, repairs the dream with wonder and creativity, and leaves the world peaceful for restful sleep. 1 scene = 1 image = 1 narration clip.",
    characters: [
      {
        name: "Lumi",
        description:
          "A kind, gentle, and curious 6-year-old girl with wavy silver-lavender hair tied loosely with a star clip, warm hazel eyes, wearing a cozy midnight-blue wool cardigan over a pastel-pink dress, soft lavender slipper boots, and carrying a small satchel of starry thread. The main dream repairer who listens with great empathy.",
      },
      {
        name: "Finn",
        description:
          "A playful, imaginative, and creative 6-year-old boy with messy curly chestnut-brown hair, bright green eyes, wearing a mint-green cozy jumper, rolled denim trousers, yellow moccasin slippers, and carrying a lightweight wooden dream wrench. Full of whimsical repair ideas.",
      },
      {
        name: "Nox",
        description:
          "A calm, thoughtful, and observant 6-year-old boy with neat dark navy-black hair, gentle brown eyes, wearing a soft deep-plum pajama suit with subtle golden constellation patterns, and carrying an antique dream lantern that glows with soothing warm amber light.",
      },
      {
        name: "Puff",
        description:
          "A small, friendly, floating white cloud helper with rosy pink cheeks and soft round eyes, wearing a tiny silver bell collar, capable of changing shape and carrying dream tools like star glue and cloud patches on its fluffy back.",
      },
    ],
    environments: [
      {
        name: "The Dream Repair Shop Workshop",
        description:
          "A cozy clockwork and moonbeam workshop filled with jars of star glue, spools of glowing rainbow thread, hanging dream keys, and plush floor cushions beneath arched skylights.",
      },
      {
        name: "The Cloud Forest of Lost Colors",
        description:
          "A surreal dream forest with lavender cloud trees, soft cotton-candy moss, and floating islands under a pastel twilight sky.",
      },
      {
        name: "The Starry Sea Shore",
        description:
          "A peaceful shoreline where gentle waves of liquid starlight lap against pearlescent sand, with glowing seashells and quiet bellflower reeds.",
      },
      {
        name: "The Pillow Mountain Peaks",
        description:
          "Towering rolling hills made of soft silk and velvet pillows under a soothing violet sky with two gentle crescent moons.",
      },
    ],
    season1Episodes: [
      { episodeNumber: 1, title: "The Rainbow With a Missing Color", premise: "A rainbow in a child's dream has lost its blue stripe; the team discovers a lonely little raindrop kept it to feel beautiful and weaves a glowing blue ribbon so both can shine." },
      { episodeNumber: 2, title: "The Monster Who Was Afraid of the Dark", premise: "A friendly furry monster under the bed is too scared to sleep; the team introduces gentle glowing moss and star jars to make bedtime cozy." },
      { episodeNumber: 3, title: "The Dragon Who Could Not Fall Asleep", premise: "A giant pastel dragon keeps tossing and turning in its crystal cave; the team fluffs a mountain of cloud pillows and plays a warm lullaby." },
      { episodeNumber: 4, title: "The Cloud That Forgot How to Float", premise: "A heavy, sorrowful little cloud sits on the grass; the team shares cheerful memories to help it become light and drift upward." },
      { episodeNumber: 5, title: "The Moon With a Silver Crack", premise: "A fallen star left a hairline crack across the crescent moon; the team uses star glue and golden dust to mend the night sky." },
      { episodeNumber: 6, title: "The Lost Lullaby Melody", premise: "Notes of a gentle lullaby escape from their music box and hide in bellflowers; the team hums softly to gather them back into harmony." },
      { episodeNumber: 7, title: "The Dream With No Colors", premise: "A child's dream garden turns entirely black and white; the team dips brushes into moonlight paint and rainbow puddles to splash gentle pastel hues." },
      { episodeNumber: 8, title: "The Untangled Dream Kite", premise: "A diamond-shaped dream kite gets tangled in floating willow branches; Finn devises a gentle wind-spiral to glide it free." },
      { episodeNumber: 9, title: "The Stepping Stones That Sank", premise: "Dream stepping stones over a starry ocean sink when travelers feel impatient; the team learns that slow, steady steps keep them buoyant." },
      { episodeNumber: 10, title: "The Star That Lost Its Twinkle", premise: "A tired little star feels too dim; the team polishes it with velvet nebula cloth and reassures it that resting makes light brighter." },
      { episodeNumber: 11, title: "The Teacup That Overflowed With Worries", premise: "A dream tea party has teacups overflowing with fizzy worry bubbles; the team gently blows the bubbles away into the sky." },
      { episodeNumber: 12, title: "The Tree With Upside-Down Leaves", premise: "A magical weeping willow has leaves that flutter downward instead of upward; the team uses cloud patches to comfort its roots." },
      { episodeNumber: 13, title: "The Whispering Pillow Peak", premise: "A high mountain of soft feather pillows won't settle because chilly breezes rustle its seams; the team stitches them with warm fleece thread." },
      { episodeNumber: 14, title: "The Ship That Sailed on Dry Land", premise: "A dream sailboat is stranded on sand; the team paints a luminescent tidal wave of lavender seafoam to lift its hull." },
      { episodeNumber: 15, title: "The Clock That Ticked Backwards", premise: "A grandmother clock in a bedtime dream keeps rewinding time because a child isn't ready for tomorrow; the team offers gentle reassurance." },
      { episodeNumber: 16, title: "The Blanket Fort That Kept Tumbling", premise: "A blanket castle collapses under the weight of heavy thoughts; the team props it up with sturdy candy-cane beams." },
      { episodeNumber: 17, title: "The Shadow That Wanted a Hug", premise: "A shadowy silhouette looks frightening in the corner until the team approaches with the amber lantern and discovers it just wants a warm hug." },
      { episodeNumber: 18, title: "The Carousel That Lost Its Music", premise: "Wooden painted carousel ponies stand frozen on the clouds; the team tunes the brass music chime to restart their gentle trot." },
      { episodeNumber: 19, title: "The Flower That Bloomed Only in Whispers", premise: "A shy dream lily only unfurls its petals when spoken to with quiet, loving kindness." },
      { episodeNumber: 20, title: "The Lantern That Shone Too Brightly", premise: "A blinding searchlight disturbs sleeping dream creatures; the team covers it with a soft blue silk shade." },
      { episodeNumber: 21, title: "The Raindrop That Wanted to Fly", premise: "A brave little raindrop wants to explore the upper sky; Puff carries it up on a fluffy cloud elevator." },
      { episodeNumber: 22, title: "The Bubble That Wouldn't Pop", premise: "A giant dream bubble traps a collection of bedtime storybooks; the team sings a soothing note that dissolves the bubble into sparkles." },
      { episodeNumber: 23, title: "The Train That Missed Its Sleepy Station", premise: "The Dream Express train races past the bedtime depot; the team lays tracks made of velvet ribbon to slow it to a gentle halt." },
      { episodeNumber: 24, title: "The Mirror That Showed Only Frowns", premise: "A pool of water reflects sad faces until the team drops floating heart petals that ripple smiles across the surface." },
      { episodeNumber: 25, title: "The Grand Bedtime Symphony", premise: "All the repaired dream creatures gather around the Great Moon Lantern for a quiet, comforting lullaby as the child drifts into deep, peaceful sleep." },
    ],
    nextEpisode: {
      episodeNumber: 1,
      title: "The Rainbow With a Missing Color",
      premise:
        "A rainbow arching over the Cloud Forest has lost its vibrant blue stripe, leaving a faded gray gap in the sky. Lumi, Finn, Nox, and Puff enter the dream and discover that Dribble, a lonely little crystal raindrop, has been keeping the blue color band because he felt plain and unloved.",
      mainCharacterName: "Lumi",
      scenes: [
        {
          sceneNumber: 1,
          environmentDescription:
            "Inside the Dream Repair Shop workshop, filled with shelves of glowing star jars, wooden clockwork gears, and spools of pastel thread.",
          action:
            "Lumi holds a soft chime receiver shaped like a brass seashell that begins to glow blue, while Finn inspects tool wrenches, Nox holds his amber dream lantern, and Puff floats with a jar of star glue.",
          narrationText:
            "High above the sleeping world, inside the cozy Dream Repair Shop, a brass seashell chime began to glow with soft azure light. Lumi tilted her head, listening to the gentle chime. 'A dream signal!' she whispered warmly. 'A child's dream rainbow has lost its blue stripe!'",
          cameraAngle: "medium",
          lighting: "warm starry glow through skylights with amber lantern light",
          characterNames: ["Lumi", "Finn", "Nox", "Puff"],
          characterVisuals: [
            { name: "Lumi", visualForm: "kind 6-year-old girl with wavy lavender-silver hair, midnight-blue cardigan, pink dress", humanoidAllowed: true },
            { name: "Finn", visualForm: "playful 6-year-old boy with curly chestnut hair, mint-green sweater, yellow slippers", humanoidAllowed: true },
            { name: "Nox", visualForm: "calm 6-year-old boy with navy hair, plum pajama suit with star patterns, amber lantern", humanoidAllowed: true },
            { name: "Puff", visualForm: "small floating white cloud helper with rosy cheeks and silver bell collar", humanoidAllowed: false },
          ],
          supportingEntities: [],
          continuityAnchors: ["Dream Repair Shop shelves with jars of glowing star glue and rainbow thread."],
          sceneDetails:
            "Lumi: hands cupped around glowing seashell chime, caring empathetic smile, lavender-silver hair. Finn: curious grin, holding wooden dream tool. Nox: holding amber lantern calmly. Puff: floating happily with rosy cheeks. Atmosphere of gentle bedtime wonder.",
        },
        {
          sceneNumber: 2,
          environmentDescription:
            "The entrance to the Cloud Forest under a twilight sky, looking up at a grand arching rainbow missing its middle blue stripe.",
          action:
            "The team steps onto soft purple cloud grass and looks up at a massive arching rainbow that has an empty, faded grey gap where the bright blue stripe should be.",
          narrationText:
            "With a soft shimmer, the team stepped through the Moonbeam Door into the Cloud Forest. Overhead arched a magnificent rainbow — red, orange, yellow, and green — but right in the middle was a hollow grey gap. 'The blue stripe is completely gone,' said Nox softly, raising his amber lantern.",
          cameraAngle: "establishing",
          lighting: "dreamy pastel twilight with soft rainbow illumination",
          characterNames: ["Lumi", "Finn", "Nox", "Puff"],
          characterVisuals: [
            { name: "Lumi", visualForm: "kind 6-year-old girl with wavy lavender-silver hair, midnight-blue cardigan, pink dress", humanoidAllowed: true },
            { name: "Finn", visualForm: "playful 6-year-old boy with curly chestnut hair, mint-green sweater, yellow slippers", humanoidAllowed: true },
            { name: "Nox", visualForm: "calm 6-year-old boy with navy hair, plum pajama suit with star patterns, amber lantern", humanoidAllowed: true },
            { name: "Puff", visualForm: "small floating white cloud helper with rosy cheeks and silver bell collar", humanoidAllowed: false },
          ],
          supportingEntities: [],
          continuityAnchors: ["Incomplete rainbow arching across the pastel sky with a grey gap."],
          sceneDetails:
            "Lumi: looking up with gentle concern, hand on chest. Finn: shading eyes with hand, looking up. Nox: holding up amber lantern. Puff: floating alongside them. A tranquil, poetic dreamscape.",
        },
        {
          sceneNumber: 3,
          environmentDescription:
            "A secluded glade of weeping lavender cloud willows beside a pond of still starlight.",
          action:
            "Lumi kneels beside a weeping cloud willow and discovers Dribble, a tiny teardrop-shaped crystal raindrop, curled up hugging a glowing ribbon of pure sapphire blue light.",
          narrationText:
            "Following a trail of soft blue sparkles between the weeping cloud trees, Lumi peeked behind a silver leaf. There, sitting on a fluffy moss cushion, was Dribble, a tiny crystal raindrop wrapped tightly in the glowing blue stripe like a warm blanket, sniffling quietly.",
          cameraAngle: "medium",
          lighting: "cool sapphire glow from the ribbon and warm amber lantern beam",
          characterNames: ["Lumi", "Finn", "Nox", "Puff"],
          characterVisuals: [
            { name: "Lumi", visualForm: "kind 6-year-old girl with wavy lavender-silver hair, midnight-blue cardigan, pink dress", humanoidAllowed: true },
            { name: "Finn", visualForm: "playful 6-year-old boy with curly chestnut hair, mint-green sweater, yellow slippers", humanoidAllowed: true },
            { name: "Nox", visualForm: "calm 6-year-old boy with navy hair, plum pajama suit with star patterns, amber lantern", humanoidAllowed: true },
            { name: "Puff", visualForm: "small floating white cloud helper with rosy cheeks and silver bell collar", humanoidAllowed: false },
          ],
          supportingEntities: [
            "Dribble the Raindrop: a tiny cute crystal raindrop creature with round glassy eyes and a shy smile, holding a shimmering ribbon of blue light.",
          ],
          continuityAnchors: ["Glowing sapphire ribbon of rainbow color wrapped around Dribble."],
          sceneDetails:
            "Lumi: kneeling down gently, open caring hands, soothing expression. Dribble: round watery eyes, clutching the blue ribbon shyly. Finn and Nox: standing back quietly with respect. Puff: hovering softly. Gentle, non-threatening emotional warmth.",
        },
        {
          sceneNumber: 4,
          environmentDescription:
            "Beside the starlight pond under the lavender cloud trees.",
          action:
            "Lumi and Finn gently weave a shimmering silver-and-gold starlight ribbon from Lumi's satchel to give to Dribble, while Dribble happily untangles the blue stripe to return it.",
          narrationText:
            "'I'm just a plain little raindrop,' whispered Dribble softly. 'I wanted to wear something beautiful.' Lumi smiled with deep tenderness. 'You reflect all the stars in the sky, Dribble!' Together, Lumi and Finn wove a sparkling silver starlight ribbon just for him, and Dribble beamed with joyful pride.",
          cameraAngle: "medium",
          lighting: "magical sparkling golden and silver light intertwining with sapphire glow",
          characterNames: ["Lumi", "Finn", "Nox", "Puff"],
          characterVisuals: [
            { name: "Lumi", visualForm: "kind 6-year-old girl with wavy lavender-silver hair, midnight-blue cardigan, pink dress", humanoidAllowed: true },
            { name: "Finn", visualForm: "playful 6-year-old boy with curly chestnut hair, mint-green sweater, yellow slippers", humanoidAllowed: true },
            { name: "Nox", visualForm: "calm 6-year-old boy with navy hair, plum pajama suit with star patterns, amber lantern", humanoidAllowed: true },
            { name: "Puff", visualForm: "small floating white cloud helper with rosy cheeks and silver bell collar", humanoidAllowed: false },
          ],
          supportingEntities: [
            "Dribble the Raindrop: now wearing a sparkling silver star ribbon around his middle, glowing happily.",
          ],
          continuityAnchors: ["Puff carrying a jar of star glue and spool of silver thread on his back."],
          sceneDetails:
            "Lumi: tying the silver ribbon around Dribble with a gentle smile. Finn: cheering with thumbs up. Dribble: glowing brightly, hands clasped in happiness, floating with joy. Nox and Puff: watching peacefully. Emotional healing and generous sharing.",
        },
        {
          sceneNumber: 5,
          environmentDescription:
            "The completed radiant rainbow arching across the Cloud Forest and sleepy pastel horizon under two peaceful crescent moons.",
          action:
            "Lumi and Puff release the blue stripe into the sky with a sprinkle of sparkle dust; the rainbow blazes with harmonious complete colors, and Dribble waves happily as bedtime peace blankets the world.",
          narrationText:
            "With a sprinkle of sparkle dust, Puff floated upward, guiding the blue stripe back into place. Click! The rainbow lit up in seamless harmony across the dream sky! Dribble waved with his sparkling ribbon, and the dream world settled into quiet, cozy slumber. Sleep tight, little dreamer.",
          cameraAngle: "establishing",
          lighting: "radiant harmonious rainbow illumination over peaceful lavender twilight",
          characterNames: ["Lumi", "Finn", "Nox", "Puff"],
          characterVisuals: [
            { name: "Lumi", visualForm: "kind 6-year-old girl with wavy lavender-silver hair, midnight-blue cardigan, pink dress", humanoidAllowed: true },
            { name: "Finn", visualForm: "playful 6-year-old boy with curly chestnut hair, mint-green sweater, yellow slippers", humanoidAllowed: true },
            { name: "Nox", visualForm: "calm 6-year-old boy with navy hair, plum pajama suit with star patterns, amber lantern", humanoidAllowed: true },
            { name: "Puff", visualForm: "small floating white cloud helper with rosy cheeks and silver bell collar", humanoidAllowed: false },
          ],
          supportingEntities: [
            "Dribble the Raindrop: sitting on a cloud flower waving happily, sparkling in the rainbow glow.",
          ],
          continuityAnchors: ["Complete full rainbow arching across the night sky, vibrant and peaceful."],
          sceneDetails:
            "Lumi: waving goodbye with a serene, peaceful smile, hands relaxed. Finn and Nox: standing peacefully beside her. Puff: doing a gentle loop in the sky. Dribble: smiling with calm contentment. Ultimate bedtime tranquility, warmth, and soothing resolution.",
        },
      ],
    },
  },
];
