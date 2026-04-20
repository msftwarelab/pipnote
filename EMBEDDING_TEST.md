# Embedding Test Plan

## Task 3.1: Embeddings on Save - Testing

### What to Test:
1. Open the app (pnpm tauri dev)
2. Create a new note with this content:
   ```
   Machine learning is transforming software development. Neural networks can now understand natural language and generate human-like responses. This technology enables semantic search, where we find information by meaning rather than exact keywords.
   ```
3. Save the note (Cmd+S)
4. Check console for embedding generation logs
5. Verify embedding file exists

### Expected Console Output:
```
💾 Saving new note...
🤖 Classifying note with Ollama...
✅ Classification successful!
  📝 Title: "..."
  📂 Category: "..."
💾 Writing file to: notes/.../....md
🔢 Generating embedding for content...
✅ Generated 768-dimensional embedding
🔢 Rust: Writing embedding for note: notes/.../....md
📁 Rust: Embedding will be saved to: .embeddings/.../....json
✅ Rust: Embedding saved successfully!
✅ New note saved successfully!
```

### Verification Commands:
```bash
# Check .embeddings directory structure
ls -R ~/Library/Application\ Support/com.tauri.dev/vault/.embeddings/

# View a specific embedding file
cat ~/Library/Application\ Support/com.tauri.dev/vault/.embeddings/[Category]/[Subcategory]/[Title].json | python3 -m json.tool | head -20

# Count embedding dimensions
cat ~/Library/Application\ Support/com.tauri.dev/vault/.embeddings/[path]/[file].json | python3 -c "import sys, json; data=json.load(sys.stdin); print(f'Dimensions: {len(data[\"embedding\"])}')"
```

### Success Criteria:
✅ Embedding file created in `.embeddings/` mirroring note path
✅ JSON contains: `embedding` (array of 768 floats), `model`, `created_at`
✅ Console shows successful generation
✅ No errors in save flow
