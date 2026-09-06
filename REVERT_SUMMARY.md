# Character Image Generation Revert Summary

## Changes Made

### Reverted from Pollinations API → Back to AnyAPI

**Date**: Aug 3, 2026

**Reason**: Revert to AnyAPI with Gemini model for character portrait generation (single call per character)

---

## Files Modified

### 1. `src/services/characterSheetService.ts`

**Line 4**: Import statement
```typescript
// Before:
import { generatePollinationsImage } from "../providers/pollinationsImageClient.js";

// After:
import { generateAnyApiSceneImage } from "../providers/anyApiImageClient.js";
```

**Line 19**: Model constant
```typescript
// Before:
export const PORTRAIT_MODEL = "flux";

// After:
export const PORTRAIT_MODEL = "google/gemini-3.1-flash-image";
```

**Line 209**: Portrait generation call
```typescript
// Before:
portraitBytes = await generatePollinationsImage(prompt, PORTRAIT_MODEL as "flux");

// After:
portraitBytes = await generateAnyApiSceneImage(prompt, PORTRAIT_MODEL);
```

### 2. `src/index.ts`

**Lines 102-106**: System prompt update
```typescript
// Before:
// ...using Pollinations flux model...

// After:
// ...using AnyAPI with Google Gemini model...
```

---

## Configuration

### AnyAPI Model Used
- **Model**: `google/gemini-3.1-flash-image`
- **Provider**: AnyAPI
- **Type**: Single call per character
- **Fallback**: Cloudflare (for scene images only, character portraits use AnyAPI only)

### Key Points
✅ Single model call per character (no parallel models)
✅ Uses Google Gemini for high-quality character portraits
✅ Maintains existing retry and key rotation logic from AnyAPI client
✅ Character descriptions extracted from portraits remain the same
✅ Scene image generation continues to use AnyAPI → Cloudflare fallback

---

## Impact

### Character Portrait Generation
- **Before**: Pollinations flux API (free, no key needed)
- **After**: AnyAPI with Gemini (requires ANYAPI_KEY)

### Scene Image Generation
- **Unchanged**: Still uses AnyAPI → Cloudflare fallback

### Character Consistency
- **Unchanged**: Character bible entries (generation prompts) remain the same
- **Unchanged**: Scene QA checks for color/appearance mismatches remain active

---

## Testing Checklist

- [ ] Verify AnyAPI keys are configured (ANYAPI_KEY environment variables)
- [ ] Generate a character sheet and verify portrait quality
- [ ] Verify character description extraction works correctly
- [ ] Verify character signature prompt distillation works
- [ ] Generate a scene image and verify character consistency
- [ ] Run scene QA and verify color/appearance checks pass

---

## Notes

The Pollinations API client (`src/providers/pollinationsImageClient.ts`) remains in the codebase but is no longer used for character generation. It can be removed in a future cleanup if not needed for other purposes.

All other functionality remains unchanged:
- Scene image generation (AnyAPI → Cloudflare)
- Character description extraction
- Character signature prompt distillation
- Scene QA with color/appearance validation
- Video assembly with ffmpeg
