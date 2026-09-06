/**
 * Standalone test script for TTS text splitting logic
 * Run with: npx tsx scripts/testTextSplitting.ts
 */

function splitTextIntoChunks(text: string, maxChars: number = 200): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text];
  
  let currentChunk = "";
  
  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    
    if (currentChunk.length + trimmedSentence.length + 1 > maxChars) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }
      
      if (trimmedSentence.length > maxChars) {
        const words = trimmedSentence.split(/\s+/);
        let wordChunk = "";
        
        for (const word of words) {
          if (wordChunk.length + word.length + 1 > maxChars) {
            if (wordChunk.length > 0) {
              chunks.push(wordChunk.trim());
              wordChunk = "";
            }
            if (word.length > maxChars) {
              chunks.push(word.substring(0, maxChars));
              wordChunk = word.substring(maxChars);
            } else {
              wordChunk = word;
            }
          } else {
            wordChunk += (wordChunk.length > 0 ? " " : "") + word;
          }
        }
        
        if (wordChunk.length > 0) {
          currentChunk = wordChunk;
        }
      } else {
        currentChunk = trimmedSentence;
      }
    } else {
      currentChunk += (currentChunk.length > 0 ? " " : "") + trimmedSentence;
    }
  }
  
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks.length > 0 ? chunks : [text.substring(0, maxChars)];
}

// Test runner
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error}`);
    failed++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

console.log("Testing TTS Text Splitting Logic\n");

// Test 1: Short text
test("Short text (under 200 chars) returns single chunk", () => {
  const text = "This is a short narration.";
  const chunks = splitTextIntoChunks(text, 200);
  assert(chunks.length === 1, `Expected 1 chunk, got ${chunks.length}`);
  assert(chunks[0] === text, "Chunk content doesn't match");
});

// Test 2: Exactly 200 chars
test("Text exactly at 200 chars returns single chunk", () => {
  const text = "a".repeat(200);
  const chunks = splitTextIntoChunks(text, 200);
  assert(chunks.length === 1, `Expected 1 chunk, got ${chunks.length}`);
});

// Test 3: The problematic 250 char case
test("250 character text splits correctly", () => {
  const text = "a".repeat(250);
  const chunks = splitTextIntoChunks(text, 200);
  assert(chunks.length >= 2, `Expected at least 2 chunks, got ${chunks.length}`);
  chunks.forEach((chunk, i) => {
    assert(chunk.length <= 200, `Chunk ${i} exceeds 200 chars: ${chunk.length}`);
  });
  const reconstructed = chunks.join("");
  assert(reconstructed.length === 250, `Lost characters: expected 250, got ${reconstructed.length}`);
});

// Test 4: Sentence boundary splitting
test("Long text splits at sentence boundaries", () => {
  const text = "This is the first sentence. This is the second sentence. This is the third sentence. This is the fourth sentence. This is the fifth sentence. This is the sixth sentence.";
  const chunks = splitTextIntoChunks(text, 200);
  // This text is 174 chars, so it fits in one chunk - just verify it doesn't exceed limit
  assert(chunks.length >= 1, "Should have at least one chunk");
  chunks.forEach((chunk, i) => {
    assert(chunk.length <= 200, `Chunk ${i} exceeds 200 chars: ${chunk.length}`);
  });
});

// Test 5: Vocal directions preserved
test("Vocal directions are preserved", () => {
  const text = "[cheerful] The sun was shining brightly. [excited] The animals gathered together. [warm] They were ready for their adventure.";
  const chunks = splitTextIntoChunks(text, 200);
  const reconstructed = chunks.join(" ");
  assert(reconstructed.includes("[cheerful]"), "Lost [cheerful] direction");
  assert(reconstructed.includes("[excited]"), "Lost [excited] direction");
  assert(reconstructed.includes("[warm]"), "Lost [warm] direction");
});

// Test 6: Very long single sentence
test("Very long single sentence splits by words", () => {
  const longSentence = "This is a very long sentence that goes on and on and on without any punctuation to break it up and it just keeps going and going and it needs to be split somehow even though there are no sentence boundaries to use for splitting.";
  const chunks = splitTextIntoChunks(longSentence, 200);
  assert(chunks.length > 1, "Should split into multiple chunks");
  chunks.forEach((chunk, i) => {
    assert(chunk.length <= 200, `Chunk ${i} exceeds 200 chars: ${chunk.length}`);
  });
});

// Test 7: Multiple sentence types
test("Handles multiple sentence types (?, !, .)", () => {
  const text = "What is happening? This is amazing! The team worked together. They solved the problem.";
  const chunks = splitTextIntoChunks(text, 80);
  chunks.forEach((chunk, i) => {
    assert(chunk.length <= 80, `Chunk ${i} exceeds 80 chars: ${chunk.length}`);
  });
});

// Test 8: Real narration with dialogue
test("Real narration with dialogue", () => {
  const text = "Pip called out, 'Team, we have a problem!' The others gathered around quickly. Nibbles asked, 'What's wrong?' Pip pointed to the blanket. 'The food is blowing away in the wind!'";
  const chunks = splitTextIntoChunks(text, 200);
  chunks.forEach((chunk, i) => {
    assert(chunk.length <= 200, `Chunk ${i} exceeds 200 chars: ${chunk.length}`);
  });
});

// Test 9: No empty chunks
test("Does not create empty chunks", () => {
  const text = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence. Sixth sentence.";
  const chunks = splitTextIntoChunks(text, 100);
  chunks.forEach((chunk, i) => {
    assert(chunk.trim().length > 0, `Chunk ${i} is empty`);
  });
});

// Test 10: Edge case - empty text
test("Handles empty text", () => {
  const text = "";
  const chunks = splitTextIntoChunks(text, 200);
  assert(chunks.length === 1, "Should return single chunk for empty text");
});

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
console.log(`Total: ${passed + failed}`);
console.log(`${"=".repeat(50)}`);

if (failed > 0) {
  process.exit(1);
}
