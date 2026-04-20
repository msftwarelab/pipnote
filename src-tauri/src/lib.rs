use std::fs;
use tauri::Manager;
use serde::{Serialize, Deserialize};
use std::sync::Mutex;
use std::path::{Path, PathBuf};
use std::collections::HashSet;
use std::cmp::Ordering;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use reqwest::Client;

struct AppState {
    vault_path: Mutex<Option<PathBuf>>,
    semantic_cache: Mutex<Option<SemanticCache>>,
    semantic_cache_stats: Mutex<SemanticCacheStats>,
}

#[derive(Debug, Clone)]
struct SemanticCacheChunk {
    embedding: Vec<f64>,
    excerpt: Option<String>,
}

#[derive(Debug, Clone)]
struct SemanticCacheEntry {
    path: String,
    embedding: Option<Vec<f64>>,
    chunks: Vec<SemanticCacheChunk>,
}

#[derive(Debug, Clone)]
struct SemanticCache {
    vault_path: PathBuf,
    entries: Vec<SemanticCacheEntry>,
}

#[derive(Serialize, Debug, Clone)]
struct FilePreviewResponse {
    kind: String,
    file_name: String,
    mime_type: Option<String>,
    data_url: Option<String>,
    text: Option<String>,
    message: Option<String>,
    size_bytes: u64,
}

#[derive(Serialize, Debug, Clone)]
struct AIReadableFileResponse {
    kind: String,
    content: String,
    message: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct LocalAiModelResponse {
    name: String,
    size: Option<u64>,
    modified_at: Option<String>,
    capability: String,
    capabilities: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct LocalAiTextResponse {
    text: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct LocalAiEmbeddingResponse {
    embedding: Vec<f64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct SemanticCacheStats {
    queries: u64,
    hits: u64,
    misses: u64,
    rebuilds: u64,
    entries: usize,
    last_built_at: Option<String>,
}

impl SemanticCacheStats {
    fn new() -> Self {
        Self {
            queries: 0,
            hits: 0,
            misses: 0,
            rebuilds: 0,
            entries: 0,
            last_built_at: None,
        }
    }
}

fn invalidate_semantic_cache(app_handle: &tauri::AppHandle) {
    let state = app_handle.state::<AppState>();
    if let Ok(mut guard) = state.semantic_cache.lock() {
        *guard = None;
    };
    if let Ok(mut stats) = state.semantic_cache_stats.lock() {
        stats.entries = 0;
    };
}

// Helper to get the current vault path
fn get_vault_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let state = app_handle.state::<AppState>();
    if let Some(path) = state.vault_path.lock().unwrap().clone() {
        return Ok(path);
    }

    Err("No vault selected yet. Choose a folder to start.".to_string())
}

fn normalize_note_path(raw_path: &str) -> String {
    let mut normalized = raw_path.replace('\\', "/");
    while normalized.starts_with('/') {
        normalized = normalized[1..].to_string();
    }
    normalized
}

fn candidate_note_paths(raw_path: &str) -> Vec<String> {
    let normalized = normalize_note_path(raw_path);
    if normalized.is_empty() {
        return Vec::new();
    }

    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    let mut push_candidate = |candidate: String| {
        if !candidate.is_empty() && seen.insert(candidate.clone()) {
            candidates.push(candidate);
        }
    };

    push_candidate(normalized.clone());
    if normalized.starts_with("notes/") {
        push_candidate(normalized.trim_start_matches("notes/").to_string());
    } else {
        push_candidate(format!("notes/{}", normalized));
    }

    candidates
}

fn embedding_relative_path_for(note_path: &str) -> PathBuf {
    let normalized = normalize_note_path(note_path);
    let mut rel_path = PathBuf::from(normalized);
    rel_path.set_extension("json");
    rel_path
}

fn cleanup_empty_embedding_parents(embeddings_root: &Path, full_path: &Path) {
    let mut parent = full_path.parent().map(|path| path.to_path_buf());
    while let Some(dir) = parent {
        if dir == embeddings_root {
            break;
        }

        let is_empty = match fs::read_dir(&dir) {
            Ok(mut entries) => entries.next().is_none(),
            Err(_) => false,
        };

        if !is_empty {
            break;
        }

        if fs::remove_dir(&dir).is_err() {
            break;
        }

        parent = dir.parent().map(|path| path.to_path_buf());
    }
}

fn mime_type_for_extension(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0;

    while index + 3 <= bytes.len() {
        let chunk = ((bytes[index] as u32) << 16)
            | ((bytes[index + 1] as u32) << 8)
            | (bytes[index + 2] as u32);
        output.push(TABLE[((chunk >> 18) & 0x3f) as usize] as char);
        output.push(TABLE[((chunk >> 12) & 0x3f) as usize] as char);
        output.push(TABLE[((chunk >> 6) & 0x3f) as usize] as char);
        output.push(TABLE[(chunk & 0x3f) as usize] as char);
        index += 3;
    }

    let remaining = bytes.len() - index;
    if remaining == 1 {
        let chunk = (bytes[index] as u32) << 16;
        output.push(TABLE[((chunk >> 18) & 0x3f) as usize] as char);
        output.push(TABLE[((chunk >> 12) & 0x3f) as usize] as char);
        output.push('=');
        output.push('=');
    } else if remaining == 2 {
        let chunk = ((bytes[index] as u32) << 16) | ((bytes[index + 1] as u32) << 8);
        output.push(TABLE[((chunk >> 18) & 0x3f) as usize] as char);
        output.push(TABLE[((chunk >> 12) & 0x3f) as usize] as char);
        output.push(TABLE[((chunk >> 6) & 0x3f) as usize] as char);
        output.push('=');
    }

    output
}

fn strip_xml_tags(raw: &str) -> String {
    let mut text = String::with_capacity(raw.len());
    let mut in_tag = false;

    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                text.push(' ');
            }
            _ if !in_tag => text.push(ch),
            _ => {}
        }
    }

    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn compact_extracted_text(raw: &str) -> String {
    raw.replace('\0', " ")
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn unique_temp_ocr_path(extension: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    std::env::temp_dir().join(format!("clu-ocr-{}-{}.{}", pid, nanos, extension))
}

fn rasterize_image_for_ocr(file_path: &Path) -> Result<PathBuf, String> {
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    if matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "bmp" | "tiff" | "tif") {
        return Ok(file_path.to_path_buf());
    }

    let temp_output = unique_temp_ocr_path("png");
    let status = Command::new("sips")
        .arg("-s")
        .arg("format")
        .arg("png")
        .arg(file_path)
        .arg("--out")
        .arg(&temp_output)
        .status()
        .map_err(|error| format!("Failed to prepare image for OCR: {}", error))?;

    if !status.success() {
        return Err("Failed to convert image into an OCR-friendly format.".to_string());
    }

    Ok(temp_output)
}

fn extract_image_ocr_text(file_path: &Path) -> Result<String, String> {
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    if extension == "svg" {
        return Err("SVG OCR is not supported yet.".to_string());
    }

    let prepared_path = rasterize_image_for_ocr(file_path)?;
    let should_cleanup = prepared_path != file_path;

    let output = Command::new("tesseract")
        .arg(&prepared_path)
        .arg("stdout")
        .arg("--psm")
        .arg("6")
        .output()
        .map_err(|error| format!("Failed to run local OCR: {}", error))?;

    if should_cleanup {
        let _ = fs::remove_file(&prepared_path);
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            return Err(format!("Local OCR failed: {}", stderr));
        }
        return Err("Local OCR failed for this image.".to_string());
    }

    let text = compact_extracted_text(&String::from_utf8_lossy(&output.stdout));
    if text.trim().is_empty() {
        return Err("No readable OCR text was found in this image.".to_string());
    }

    Ok(text)
}

fn normalize_external_base_url(raw: &str) -> String {
    raw.trim().trim_end_matches('/').to_string()
}

fn local_ai_base_url_candidates(provider: &str, base_url: &str) -> Vec<String> {
    let normalized = normalize_external_base_url(base_url);
    if provider != "lmstudio" {
        return vec![normalized];
    }

    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |value: String| {
        if !value.is_empty() && seen.insert(value.clone()) {
            candidates.push(value);
        }
    };

    push(normalized.clone());
    if normalized.contains("://localhost") {
        push(normalized.replacen("://localhost", "://127.0.0.1", 1));
    } else if normalized.contains("://127.0.0.1") {
        push(normalized.replacen("://127.0.0.1", "://localhost", 1));
    }

    candidates
}

async fn local_ai_get_json(client: &Client, provider: &str, base_url: &str, path: &str) -> Result<serde_json::Value, String> {
    let mut last_error = String::new();
    for candidate in local_ai_base_url_candidates(provider, base_url) {
        let url = format!("{}{}", candidate, path);
        match client.get(&url).send().await {
            Ok(response) => {
                if !response.status().is_success() {
                    last_error = format!("{} responded with HTTP {} at {}", provider, response.status(), candidate);
                    continue;
                }
                return response.json::<serde_json::Value>().await.map_err(|e| e.to_string());
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }
    }
    Err(last_error)
}

async fn local_ai_post_json(client: &Client, provider: &str, base_url: &str, path: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut last_error = String::new();
    for candidate in local_ai_base_url_candidates(provider, base_url) {
        let url = format!("{}{}", candidate, path);
        match client.post(&url).json(&body).send().await {
            Ok(response) => {
                if !response.status().is_success() {
                    last_error = format!("{} responded with HTTP {} at {}", provider, response.status(), candidate);
                    continue;
                }
                return response.json::<serde_json::Value>().await.map_err(|e| e.to_string());
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }
    }
    Err(last_error)
}

fn extract_docx_text(file_path: &Path) -> Result<String, String> {
    if let Ok(output) = Command::new("textutil")
        .arg("-convert")
        .arg("txt")
        .arg("-stdout")
        .arg(file_path)
        .output()
    {
        if output.status.success() {
            if let Ok(text) = String::from_utf8(output.stdout) {
                let compacted = compact_extracted_text(&text);
                if !compacted.trim().is_empty() {
                    return Ok(compacted);
                }
            }
        }
    }

    let output = Command::new("unzip")
        .arg("-p")
        .arg(file_path)
        .arg("word/document.xml")
        .output()
        .map_err(|_| "DOCX preview needs the `unzip` command, which is not available on this machine.".to_string())?;

    if !output.status.success() {
        return Err("Could not extract text from this DOCX file.".to_string());
    }

    let xml = String::from_utf8(output.stdout).map_err(|_| "DOCX preview text could not be decoded.".to_string())?;
    let text = strip_xml_tags(&xml);
    if text.trim().is_empty() {
        return Err("This DOCX file does not contain previewable text.".to_string());
    }
    Ok(text)
}

fn list_zip_entries(file_path: &Path) -> Result<Vec<String>, String> {
    let output = Command::new("unzip")
        .arg("-Z1")
        .arg(file_path)
        .output()
        .map_err(|_| "Document extraction needs the `unzip` command, which is not available on this machine.".to_string())?;

    if !output.status.success() {
        return Err("Could not inspect the contents of this document.".to_string());
    }

    let listing = String::from_utf8(output.stdout)
        .map_err(|_| "Document archive listing could not be decoded.".to_string())?;

    Ok(listing
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect())
}

fn read_zip_entry(file_path: &Path, entry: &str) -> Result<String, String> {
    let output = Command::new("unzip")
        .arg("-p")
        .arg(file_path)
        .arg(entry)
        .output()
        .map_err(|_| "Document extraction needs the `unzip` command, which is not available on this machine.".to_string())?;

    if !output.status.success() {
        return Err(format!("Could not extract {} from this document.", entry));
    }

    String::from_utf8(output.stdout).map_err(|_| format!("Extracted {} could not be decoded.", entry))
}

fn extract_pdf_text(file_path: &Path) -> Result<String, String> {
    if let Ok(output) = Command::new("mdls")
        .arg("-raw")
        .arg("-name")
        .arg("kMDItemTextContent")
        .arg(file_path)
        .output()
    {
        if output.status.success() {
            if let Ok(text) = String::from_utf8(output.stdout) {
                let cleaned = compact_extracted_text(&text)
                    .replace("(null)", "")
                    .trim()
                    .to_string();
                if !cleaned.is_empty() {
                    return Ok(cleaned);
                }
            }
        }
    }

    if let Ok(output) = Command::new("strings")
        .arg("-n")
        .arg("6")
        .arg(file_path)
        .output()
    {
        if output.status.success() {
            if let Ok(text) = String::from_utf8(output.stdout) {
                let cleaned = compact_extracted_text(&text);
                if !cleaned.is_empty() {
                    return Ok(cleaned);
                }
            }
        }
    }

    Err("Could not extract readable text from this PDF file.".to_string())
}

fn extract_pptx_text(file_path: &Path) -> Result<String, String> {
    if let Ok(output) = Command::new("textutil")
        .arg("-convert")
        .arg("txt")
        .arg("-stdout")
        .arg(file_path)
        .output()
    {
        if output.status.success() {
            if let Ok(text) = String::from_utf8(output.stdout) {
                let compacted = compact_extracted_text(&text);
                if !compacted.trim().is_empty() {
                    return Ok(compacted);
                }
            }
        }
    }

    let mut slide_entries = list_zip_entries(file_path)?
        .into_iter()
        .filter(|entry| {
            entry.starts_with("ppt/slides/slide")
                && entry.ends_with(".xml")
                && !entry.contains("/_rels/")
        })
        .collect::<Vec<_>>();

    slide_entries.sort();
    if slide_entries.is_empty() {
        return Err("This PPTX file does not contain readable slides.".to_string());
    }

    let mut extracted_parts = Vec::new();
    for entry in slide_entries {
        let xml = read_zip_entry(file_path, &entry)?;
        let text = compact_extracted_text(&strip_xml_tags(&xml));
        if !text.trim().is_empty() {
            extracted_parts.push(text);
        }
    }

    let combined = compact_extracted_text(&extracted_parts.join("\n\n"));
    if combined.trim().is_empty() {
        return Err("Could not extract readable text from this PPTX file.".to_string());
    }

    Ok(combined)
}

fn extract_xlsx_text(file_path: &Path) -> Result<String, String> {
    let entries = list_zip_entries(file_path)?;

    let mut extracted_parts = Vec::new();

    if entries.iter().any(|entry| entry == "xl/sharedStrings.xml") {
        let shared_strings_xml = read_zip_entry(file_path, "xl/sharedStrings.xml")?;
        let shared_strings = compact_extracted_text(&strip_xml_tags(&shared_strings_xml));
        if !shared_strings.trim().is_empty() {
            extracted_parts.push(shared_strings);
        }
    }

    if entries.iter().any(|entry| entry == "xl/workbook.xml") {
        let workbook_xml = read_zip_entry(file_path, "xl/workbook.xml")?;
        let workbook_text = compact_extracted_text(&strip_xml_tags(&workbook_xml));
        if !workbook_text.trim().is_empty() {
            extracted_parts.push(workbook_text);
        }
    }

    let mut sheet_entries = entries
        .iter()
        .filter(|entry| entry.starts_with("xl/worksheets/sheet") && entry.ends_with(".xml"))
        .cloned()
        .collect::<Vec<_>>();
    sheet_entries.sort();

    for entry in sheet_entries {
        let xml = read_zip_entry(file_path, &entry)?;
        let sheet_text = compact_extracted_text(&strip_xml_tags(&xml));
        if !sheet_text.trim().is_empty() {
            extracted_parts.push(sheet_text);
        }
    }

    let combined = compact_extracted_text(&extracted_parts.join("\n\n"));
    if combined.trim().is_empty() {
        return Err("Could not extract readable text from this XLSX file.".to_string());
    }

    Ok(combined)
}

fn read_text_file_lossy(file_path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(file_path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_EDITOR_FILE_BYTES {
        return Err(format!(
            "File is too large to open in editor ({} bytes).",
            metadata.len()
        ));
    }

    let bytes = fs::read(file_path).map_err(|e| e.to_string())?;
    if looks_binary(&bytes) {
        return Err("Unsupported binary file (preview is not available yet).".to_string());
    }

    match String::from_utf8(bytes) {
        Ok(text) => Ok(text),
        Err(err) => Ok(String::from_utf8_lossy(&err.into_bytes()).to_string()),
    }
}

fn read_ai_readable_content(file_path: &Path) -> Result<AIReadableFileResponse, String> {
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    match extension.as_str() {
        "pdf" => Ok(AIReadableFileResponse {
            kind: "pdf".to_string(),
            content: extract_pdf_text(file_path)?,
            message: Some("Text extracted from PDF for search and Q&A.".to_string()),
        }),
        "docx" => Ok(AIReadableFileResponse {
            kind: "docx".to_string(),
            content: extract_docx_text(file_path)?,
            message: Some("Text extracted from DOCX for search and Q&A.".to_string()),
        }),
        "pptx" => Ok(AIReadableFileResponse {
            kind: "pptx".to_string(),
            content: extract_pptx_text(file_path)?,
            message: Some("Text extracted from PPTX for search and Q&A.".to_string()),
        }),
        "xlsx" => Ok(AIReadableFileResponse {
            kind: "xlsx".to_string(),
            content: extract_xlsx_text(file_path)?,
            message: Some("Text extracted from XLSX for search and Q&A.".to_string()),
        }),
        "csv" => Ok(AIReadableFileResponse {
            kind: "csv".to_string(),
            content: read_text_file_lossy(file_path)?,
            message: Some("Text extracted from CSV for search and Q&A.".to_string()),
        }),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "heic" | "tiff" | "tif" | "svg" => Ok(AIReadableFileResponse {
            kind: "image".to_string(),
            content: extract_image_ocr_text(file_path)?,
            message: Some("Text extracted from image using local OCR.".to_string()),
        }),
        _ => Ok(AIReadableFileResponse {
            kind: "text".to_string(),
            content: read_text_file_lossy(file_path)?,
            message: None,
        }),
    }
}

const MAX_EDITOR_FILE_BYTES: u64 = 2_500_000; // ~2.5 MB

fn is_known_binary_extension(ext: &str) -> bool {
    matches!(
        ext,
        "pdf"
            | "doc"
            | "docx"
            | "ppt"
            | "pptx"
            | "xls"
            | "xlsx"
            | "odt"
            | "ods"
            | "odp"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "ico"
            | "heic"
            | "mp3"
            | "wav"
            | "m4a"
            | "aac"
            | "flac"
            | "mp4"
            | "mov"
            | "mkv"
            | "avi"
            | "zip"
            | "rar"
            | "7z"
            | "gz"
            | "tar"
    )
}

fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let sample_len = bytes.len().min(8192);
    let sample = &bytes[..sample_len];
    if sample.iter().any(|b| *b == 0) {
        return true;
    }

    let suspicious = sample
        .iter()
        .filter(|b| {
            let c = **b;
            c < 0x09 || (c > 0x0D && c < 0x20)
        })
        .count();

    // If more than ~2% control chars in sample, treat as binary.
    suspicious * 100 > sample_len * 2
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum TreeNode {
    #[serde(rename = "file")]
    File {
        name: String,
        path: String,
        #[serde(rename = "modifiedAt")]
        modified_at: Option<String>,
    },
    #[serde(rename = "folder")]
    Folder {
        name: String,
        path: String,
        #[serde(rename = "modifiedAt")]
        modified_at: Option<String>,
        children: Vec<TreeNode>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SearchHit {
    path: String,
    title: String,
    snippet: String,
    score: i32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SemanticSearchHit {
    path: String,
    similarity: f64,
    snippet: Option<String>,
}

fn cosine_similarity(query: &[f64], candidate: &[f64]) -> Option<f64> {
    if query.is_empty() || query.len() != candidate.len() {
        return None;
    }

    let mut dot = 0.0_f64;
    let mut mag_a = 0.0_f64;
    let mut mag_b = 0.0_f64;

    for i in 0..query.len() {
        dot += query[i] * candidate[i];
        mag_a += query[i] * query[i];
        mag_b += candidate[i] * candidate[i];
    }

    if mag_a <= f64::EPSILON || mag_b <= f64::EPSILON {
        return Some(0.0);
    }

    Some(dot / (mag_a.sqrt() * mag_b.sqrt()))
}

fn parse_f64_vec(value: Option<&serde_json::Value>) -> Option<Vec<f64>> {
    let arr = value?.as_array()?;
    if arr.is_empty() {
        return None;
    }

    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        out.push(item.as_f64().unwrap_or(0.0));
    }
    Some(out)
}

fn build_semantic_cache(vault_path: &PathBuf) -> Result<SemanticCache, String> {
    let embeddings_dir = vault_path.join(".embeddings");
    if !embeddings_dir.exists() {
        return Ok(SemanticCache {
            vault_path: vault_path.clone(),
            entries: Vec::new(),
        });
    }

    let mut entries: Vec<SemanticCacheEntry> = Vec::new();

    fn walk_cache(
        dir: &std::path::Path,
        base_path: &std::path::Path,
        entries: &mut Vec<SemanticCacheEntry>,
    ) -> Result<(), String> {
        if !dir.is_dir() {
            return Ok(());
        }

        let iter = fs::read_dir(dir).map_err(|e| e.to_string())?;
        for entry in iter {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                walk_cache(&path, base_path, entries)?;
                continue;
            }

            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }

            let content = match fs::read_to_string(&path) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let embedding_data: serde_json::Value = match serde_json::from_str(&content) {
                Ok(value) => value,
                Err(_) => continue,
            };

            let mut relative_path = path
                .strip_prefix(base_path)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string();
            if relative_path.ends_with(".json") {
                relative_path = relative_path.trim_end_matches(".json").to_string();
                relative_path.push_str(".md");
            }

            let note_path = embedding_data
                .get("note_path")
                .and_then(|v| v.as_str())
                .map(|s| normalize_note_path(s))
                .filter(|s| !s.is_empty())
                .unwrap_or(relative_path);

            let base_embedding = parse_f64_vec(embedding_data.get("embedding"));
            let chunks = embedding_data
                .get("chunks")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|chunk| {
                            let embedding = parse_f64_vec(chunk.get("embedding"))?;
                            let excerpt = chunk
                                .get("excerpt")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                                .filter(|s| !s.trim().is_empty());
                            Some(SemanticCacheChunk { embedding, excerpt })
                        })
                        .collect::<Vec<SemanticCacheChunk>>()
                })
                .unwrap_or_default();

            if base_embedding.is_none() && chunks.is_empty() {
                continue;
            }

            entries.push(SemanticCacheEntry {
                path: note_path,
                embedding: base_embedding,
                chunks,
            });
        }

        Ok(())
    }

    walk_cache(&embeddings_dir, &embeddings_dir, &mut entries)?;

    Ok(SemanticCache {
        vault_path: vault_path.clone(),
        entries,
    })
}

fn read_directory_tree(path: &std::path::Path, base_path: &std::path::Path) -> Result<Vec<TreeNode>, String> {
    let mut nodes = Vec::new();
    
    let entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        
        // Skip hidden files, system files, and internal app metadata files
        if file_name.starts_with('.')
            || file_name == ".embeddings"
            || file_name == "index.json"
            || file_name == "embeddings.json" {
            continue;
        }
        
        let relative_path = file_path
            .strip_prefix(base_path)
            .unwrap_or(&file_path)
            .to_string_lossy()
            .to_string();
        
        let modified_at = fs::metadata(&file_path)
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());

        if file_path.is_dir() {
            let children = read_directory_tree(&file_path, base_path)?;
            nodes.push(TreeNode::Folder {
                name: file_name,
                path: relative_path,
                modified_at,
                children,
            });
        } else {
            nodes.push(TreeNode::File {
                name: file_name,
                path: relative_path,
                modified_at,
            });
        }
    }
    
    // Sort: folders first, then files, alphabetically
    nodes.sort_by(|a, b| {
        match (a, b) {
            (TreeNode::Folder { name: name_a, .. }, TreeNode::Folder { name: name_b, .. }) => {
                name_a.to_lowercase().cmp(&name_b.to_lowercase())
            }
            (TreeNode::File { name: name_a, .. }, TreeNode::File { name: name_b, .. }) => {
                name_a.to_lowercase().cmp(&name_b.to_lowercase())
            }
            (TreeNode::Folder { .. }, TreeNode::File { .. }) => std::cmp::Ordering::Less,
            (TreeNode::File { .. }, TreeNode::Folder { .. }) => std::cmp::Ordering::Greater,
        }
    });
    
    Ok(nodes)
}

#[tauri::command]
fn read_vault_tree(app_handle: tauri::AppHandle) -> Result<Vec<TreeNode>, String> {
    let vault_path = get_vault_path(&app_handle)?;
    
    if !vault_path.exists() {
        return Ok(Vec::new());
    }
    
    read_directory_tree(&vault_path, &vault_path)
}

#[tauri::command]
fn read_file(app_handle: tauri::AppHandle, path: String) -> Result<String, String> {
    let vault_path = get_vault_path(&app_handle)?;
    let candidates = candidate_note_paths(&path);
    if candidates.is_empty() {
        return Err(format!("File not found: {}", path));
    }

    let mut resolved_relative: Option<String> = None;
    let mut file_path: Option<PathBuf> = None;
    for relative in candidates {
        let candidate_path = vault_path.join(&relative);
        if candidate_path.exists() {
            resolved_relative = Some(relative);
            file_path = Some(candidate_path);
            break;
        }
    }

    let resolved_relative = resolved_relative.ok_or_else(|| format!("File not found: {}", path))?;
    let file_path = file_path.ok_or_else(|| format!("File not found: {}", path))?;

    if file_path.is_dir() {
        return Err(format!("Cannot open folder as file: {}", resolved_relative));
    }

    if let Some(ext) = file_path.extension().and_then(|e| e.to_str()) {
        if is_known_binary_extension(&ext.to_lowercase()) {
            return Err(format!(
                "Unsupported file type: .{} (preview is not available yet).",
                ext
            ));
        }
    }

    read_text_file_lossy(&file_path)
}

#[tauri::command]
fn read_file_preview(app_handle: tauri::AppHandle, path: String) -> Result<FilePreviewResponse, String> {
    let vault_path = get_vault_path(&app_handle)?;
    let candidates = candidate_note_paths(&path);
    if candidates.is_empty() {
        return Err(format!("File not found: {}", path));
    }

    let mut resolved_relative: Option<String> = None;
    let mut file_path: Option<PathBuf> = None;
    for relative in candidates {
        let candidate_path = vault_path.join(&relative);
        if candidate_path.exists() {
            resolved_relative = Some(relative);
            file_path = Some(candidate_path);
            break;
        }
    }

    let resolved_relative = resolved_relative.ok_or_else(|| format!("File not found: {}", path))?;
    let file_path = file_path.ok_or_else(|| format!("File not found: {}", path))?;
    if file_path.is_dir() {
        return Err(format!("Cannot preview folder as file: {}", resolved_relative));
    }

    let metadata = fs::metadata(&file_path).map_err(|e| e.to_string())?;
    let size_bytes = metadata.len();
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Preview")
        .to_string();
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    if matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "pdf") {
        let bytes = fs::read(&file_path).map_err(|e| e.to_string())?;
        let mime_type = mime_type_for_extension(&extension).to_string();
        let data_url = format!("data:{};base64,{}", mime_type, encode_base64(&bytes));
        return Ok(FilePreviewResponse {
            kind: if extension == "pdf" { "pdf".to_string() } else { "image".to_string() },
            file_name,
            mime_type: Some(mime_type),
            data_url: Some(data_url),
            text: None,
            message: None,
            size_bytes,
        });
    }

    if matches!(extension.as_str(), "docx" | "pptx" | "xlsx") {
        let (kind, extracted, mime_type, message) = match extension.as_str() {
            "docx" => (
                "docx".to_string(),
                extract_docx_text(&file_path)?,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string(),
                "Preview extracted from DOCX text content.".to_string(),
            ),
            "pptx" => (
                "pptx".to_string(),
                extract_pptx_text(&file_path)?,
                "application/vnd.openxmlformats-officedocument.presentationml.presentation".to_string(),
                "Preview extracted from PPTX slide text.".to_string(),
            ),
            _ => (
                "xlsx".to_string(),
                extract_xlsx_text(&file_path)?,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string(),
                "Preview extracted from XLSX worksheet text.".to_string(),
            ),
        };

        return Ok(FilePreviewResponse {
            kind,
            file_name,
            mime_type: Some(mime_type),
            data_url: None,
            text: Some(extracted),
            message: Some(message),
            size_bytes,
        });
    }

    Err(format!("No preview renderer is available for: {}", resolved_relative))
}

#[tauri::command]
fn read_file_for_ai(app_handle: tauri::AppHandle, path: String) -> Result<AIReadableFileResponse, String> {
    let vault_path = get_vault_path(&app_handle)?;
    let candidates = candidate_note_paths(&path);
    if candidates.is_empty() {
        return Err(format!("File not found: {}", path));
    }

    let mut file_path: Option<PathBuf> = None;
    for relative in candidates {
        let candidate_path = vault_path.join(&relative);
        if candidate_path.exists() {
            file_path = Some(candidate_path);
            break;
        }
    }

    let file_path = file_path.ok_or_else(|| format!("File not found: {}", path))?;
    if file_path.is_dir() {
        return Err(format!("Cannot open folder as file: {}", path));
    }

    read_ai_readable_content(&file_path)
}

#[tauri::command]
fn write_file(app_handle: tauri::AppHandle, path: String, content: String) -> Result<String, String> {
    let vault_path = get_vault_path(&app_handle)?;
    
    let file_path = vault_path.join(&path);
    let vault_notes_base = vault_path.clone();
    
    // Ensure parent directory exists
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    
    // If file already exists, just overwrite it (UPDATE case)
    if file_path.exists() {
        println!("📝 Updating existing file: {:?}", file_path);
        fs::write(&file_path, content).map_err(|e| e.to_string())?;
        println!("✅ File updated successfully!");
        return Ok(path);
    }
    
    // NEW file: Handle filename collisions by finding an available name
    println!("✨ Creating new file: {:?}", file_path);
    
    let mut actual_file_path = file_path.clone();
    let mut actual_relative_path = path.clone();
    
    // Extract base name and extension for collision handling
    let original_name = file_path.file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid filename")?.to_string();
    let extension = file_path.extension()
        .and_then(|s| s.to_str())
        .unwrap_or("md").to_string();
    let parent_dir = file_path.parent()
        .ok_or("Invalid parent directory")?
        .to_path_buf();
    
    // Try incrementing suffixes until we find an available name
    let mut counter = 1;
    loop {
        if !actual_file_path.exists() {
            println!("✅ Using filename: {:?}", actual_file_path);
            break
        }
        
        println!("⚠️  File already exists, trying next suffix...");
        counter += 1;
        if counter > 1000 {
            return Err("Too many filename collisions".to_string());
        }
        
        let new_name = format!("{}-{}.{}", original_name, counter, extension);
        actual_file_path = parent_dir.join(&new_name);
        
        // Calculate the actual relative path
        actual_relative_path = actual_file_path.strip_prefix(&vault_notes_base)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
    }
    
    fs::write(&actual_file_path, content).map_err(|e| e.to_string())?;
    println!("✅ New file created: {:?}", actual_file_path);
    Ok(actual_relative_path)
}


#[tauri::command]
fn set_vault_path(app_handle: tauri::AppHandle, path: String) -> Result<String, String> {
    println!("📂 Rust: Setting new vault path: {}", path);
    let state = app_handle.state::<AppState>();
    *state.vault_path.lock().unwrap() = Some(PathBuf::from(&path));
    invalidate_semantic_cache(&app_handle);
    
    // Also initialize it if needed (create .embeddings etc.)
    init_vault(app_handle, Some(path))
}

#[tauri::command]
fn init_vault(app_handle: tauri::AppHandle, custom_path: Option<String>) -> Result<String, String> {
    // Determine vault path
    let vault_path = match custom_path {
        Some(p) => PathBuf::from(p),
        None => get_vault_path(&app_handle)?,
    };
    
    // Set in state
    let state = app_handle.state::<AppState>();
    *state.vault_path.lock().unwrap() = Some(vault_path.clone());
    invalidate_semantic_cache(&app_handle);
    
    // Create vault directory if it doesn't exist
    if !vault_path.exists() {
        fs::create_dir_all(&vault_path).map_err(|e| e.to_string())?;
    }
    
    // Migrate old visible metadata file if present, then ensure hidden metadata exists.
    let legacy_index_path = vault_path.join("index.json");
    let index_path = vault_path.join(".index.json");
    if legacy_index_path.exists() && !index_path.exists() {
        fs::rename(&legacy_index_path, &index_path).map_err(|e| e.to_string())?;
    }
    if !index_path.exists() {
        let initial_index = serde_json::json!({
            "notes": [],
            "lastModified": chrono::Utc::now().to_rfc3339()
        });
        fs::write(&index_path, serde_json::to_string_pretty(&initial_index).unwrap())
            .map_err(|e| e.to_string())?;
    }
    
    // Migrate old visible metadata file if present, then ensure hidden metadata exists.
    let legacy_embeddings_path = vault_path.join("embeddings.json");
    let embeddings_path = vault_path.join(".embeddings.json");
    if legacy_embeddings_path.exists() && !embeddings_path.exists() {
        fs::rename(&legacy_embeddings_path, &embeddings_path).map_err(|e| e.to_string())?;
    }
    if !embeddings_path.exists() {
        let initial_embeddings = serde_json::json!({
            "embeddings": [],
            "lastModified": chrono::Utc::now().to_rfc3339()
        });
        fs::write(&embeddings_path, serde_json::to_string_pretty(&initial_embeddings).unwrap())
            .map_err(|e| e.to_string())?;
    }
    
    // Create .embeddings directory for individual embedding files
    let embeddings_dir = vault_path.join(".embeddings");
    if !embeddings_dir.exists() {
        fs::create_dir_all(&embeddings_dir).map_err(|e| e.to_string())?;
    }
    
    Ok(vault_path.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_path(app_handle: tauri::AppHandle, path: String) -> Result<(), String> {
    println!("🗑️ Rust: Attempting to delete path: {}", path);
    
    let vault_path = get_vault_path(&app_handle)?;
    let target_path = vault_path.join(&path);
    
    println!("🗑️  Rust: Full path: {:?}", target_path);
    
    if !target_path.exists() {
        println!("❌ Rust: Path not found: {:?}", target_path);
        return Err(format!("Path not found: {}", path));
    }
    
    let embeddings_root = vault_path.join(".embeddings");
    let normalized_path = normalize_note_path(&path);

    if target_path.is_dir() {
        println!("📁 Rust: Deleting directory: {:?}", target_path);
        fs::remove_dir_all(&target_path).map_err(|e| e.to_string())?;
        let embedding_dir = embeddings_root.join(&normalized_path);
        if embedding_dir.exists() {
            let _ = fs::remove_dir_all(&embedding_dir);
            cleanup_empty_embedding_parents(&embeddings_root, &embedding_dir);
        }
    } else {
        println!("📄 Rust: Deleting file: {:?}", target_path);
        fs::remove_file(&target_path).map_err(|e| e.to_string())?;
        let embedding_path = embeddings_root.join(embedding_relative_path_for(&normalized_path));
        if embedding_path.exists() {
            let _ = fs::remove_file(&embedding_path);
            cleanup_empty_embedding_parents(&embeddings_root, &embedding_path);
        }
    }
    
    println!("✅ Rust: Delete successful!");
    invalidate_semantic_cache(&app_handle);
    Ok(())
}

#[tauri::command]
fn rename_path(app_handle: tauri::AppHandle, old_path: String, new_name: String) -> Result<String, String> {
    println!("✏️ Rust: Renaming '{}' to '{}'", old_path, new_name);
    
    let vault_path = get_vault_path(&app_handle)?;
    let notes_base = vault_path.clone();
    let source_path = notes_base.join(&old_path);
    
    if !source_path.exists() {
        return Err(format!("Path not found: {}", old_path));
    }
    
    // Get parent directory
    let parent_dir = source_path.parent().unwrap_or(&notes_base);
    
    // Determine new path based on whether it's a file or folder
    let is_file = source_path.is_file();
    let existing_extension = source_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_string());
    let has_extension = std::path::Path::new(&new_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some();
    let new_file_name = if is_file && !has_extension {
        if let Some(extension) = existing_extension {
            format!("{}.{}", new_name, extension)
        } else {
            new_name.clone()
        }
    } else {
        new_name.clone()
    };
    
    let dest_path = parent_dir.join(&new_file_name);
    
    // Check if destination already exists
    if dest_path.exists() {
        return Err(format!("A file or folder with name '{}' already exists", new_name));
    }
    
    // Perform the rename
    fs::rename(&source_path, &dest_path).map_err(|e| e.to_string())?;
    
    // Calculate new relative path
    let new_relative_path = dest_path
        .strip_prefix(&notes_base)
        .unwrap_or(&dest_path)
        .to_string_lossy()
        .to_string();
    
    println!("✅ Rust: Renamed to: {}", new_relative_path);
    
    let embeddings_base = vault_path.join(".embeddings");
    if is_file {
        let old_embedding_path = embeddings_base.join(embedding_relative_path_for(&old_path));

        if old_embedding_path.exists() {
            let new_embedding_path = embeddings_base.join(embedding_relative_path_for(&new_relative_path));

            if let Some(parent) = new_embedding_path.parent() {
                let _ = fs::create_dir_all(parent);
            }

            let _ = fs::rename(&old_embedding_path, &new_embedding_path);
            cleanup_empty_embedding_parents(&embeddings_base, &old_embedding_path);
            println!("✅ Rust: Renamed embedding file too");
        }
    } else {
        let old_embedding_dir = embeddings_base.join(normalize_note_path(&old_path));
        if old_embedding_dir.exists() {
            let new_embedding_dir = embeddings_base.join(&new_relative_path);
            if let Some(parent) = new_embedding_dir.parent() {
                let _ = fs::create_dir_all(parent);
            }

            let _ = fs::rename(&old_embedding_dir, &new_embedding_dir);
            cleanup_empty_embedding_parents(&embeddings_base, &old_embedding_dir);
            println!("✅ Rust: Renamed embedding folder too");
        }
    }
    invalidate_semantic_cache(&app_handle);
    
    Ok(new_relative_path)
}

#[tauri::command]
fn create_file_in_folder(app_handle: tauri::AppHandle, folder_path: String, file_name: String) -> Result<String, String> {
    println!("📝 Rust: Creating file '{}' in folder '{}'", file_name, folder_path);
    
    let vault_path = get_vault_path(&app_handle)?;
    
    // Ensure file has .md extension
    let file_name = if file_name.ends_with(".md") {
        file_name
    } else {
        format!("{}.md", file_name)
    };
    
    println!("📝 Rust: Final file name: {}", file_name);
    
    let file_path = if folder_path.is_empty() {
        vault_path.join(&file_name)
    } else {
        vault_path.join(&folder_path).join(&file_name)
    };
    
    println!("📝 Rust: Full path: {:?}", file_path);
    
    // Check if file already exists
    if file_path.exists() {
        println!("❌ Rust: File already exists!");
        return Err(format!("File already exists: {}", file_name));
    }
    
    // Ensure parent directory exists
    if let Some(parent) = file_path.parent() {
        println!("📁 Rust: Creating parent directories: {:?}", parent);
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    
    // Create empty file
    fs::write(&file_path, "").map_err(|e| e.to_string())?;
    
    // Return relative path
    let relative_path = if folder_path.is_empty() {
        file_name
    } else {
        format!("{}/{}", folder_path, file_name)
    };
    
    println!("✅ Rust: File created at: {}", relative_path);
    Ok(relative_path)
}

#[tauri::command]
fn create_folder(app_handle: tauri::AppHandle, parent_path: String, folder_name: String) -> Result<String, String> {
    println!("📁 Rust: Creating folder '{}' in '{}'", folder_name, parent_path);

    let vault_path = get_vault_path(&app_handle)?;
    let parent = parent_path.trim().trim_matches('/').to_string();
    let name = folder_name.trim();

    if name.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }

    if name.contains('/') || name.contains('\\') {
        return Err("Folder name cannot contain path separators".to_string());
    }

    let new_folder_path = if parent.is_empty() {
        vault_path.join(name)
    } else {
        vault_path.join(&parent).join(name)
    };

    if new_folder_path.exists() {
        return Err(format!("Folder already exists: {}", name));
    }

    fs::create_dir_all(&new_folder_path).map_err(|e| e.to_string())?;

    let relative_path = if parent.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", parent, name)
    };

    println!("✅ Rust: Folder created at: {}", relative_path);
    Ok(relative_path)
}

#[tauri::command]
fn write_embedding(app_handle: tauri::AppHandle, note_path: String, embedding_data: String) -> Result<(), String> {
    println!("🔢 Rust: Writing embedding for note: {}", note_path);
    
    let vault_path = get_vault_path(&app_handle)?;
    let normalized_note_path = normalize_note_path(&note_path);
    if normalized_note_path.is_empty() {
        return Err("Invalid note path for embedding".to_string());
    }

    let mut embedding_value: serde_json::Value =
        serde_json::from_str(&embedding_data).map_err(|e| format!("Invalid embedding JSON: {}", e))?;
    if !embedding_value.is_object() {
        return Err("Embedding JSON must be an object".to_string());
    }
    embedding_value["note_path"] = serde_json::Value::String(normalized_note_path.clone());
    
    // Convert note path to embedding path
    // Category/Subcategory/Title.md -> .embeddings/Category/Subcategory/Title.json
    let rel_path = embedding_relative_path_for(&normalized_note_path);
    let full_path = vault_path.join(".embeddings").join(rel_path);
    
    println!("📁 Rust: Embedding will be saved to: {:?}", full_path);
    
    // Ensure parent directory exists
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    
    // Write embedding data
    fs::write(&full_path, serde_json::to_string(&embedding_value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    
    println!("✅ Rust: Embedding saved successfully!");
    invalidate_semantic_cache(&app_handle);
    Ok(())
}

#[tauri::command]
fn delete_embedding(app_handle: tauri::AppHandle, note_path: String) -> Result<bool, String> {
    let vault_path = get_vault_path(&app_handle)?;
    let normalized_note_path = normalize_note_path(&note_path);
    if normalized_note_path.is_empty() {
        return Ok(false);
    }

    let embeddings_root = vault_path.join(".embeddings");
    let full_path = embeddings_root.join(embedding_relative_path_for(&normalized_note_path));
    if !full_path.exists() {
        return Ok(false);
    }

    fs::remove_file(&full_path).map_err(|e| e.to_string())?;
    cleanup_empty_embedding_parents(&embeddings_root, &full_path);

    invalidate_semantic_cache(&app_handle);
    Ok(true)
}

#[tauri::command]
fn read_all_embeddings(app_handle: tauri::AppHandle) -> Result<String, String> {
    println!("📚 Rust: Reading all embeddings...");

    let vault_path = get_vault_path(&app_handle)?;
    let embeddings_dir = vault_path.join(".embeddings");
    
    if !embeddings_dir.exists() {
        println!("⚠️ Rust: No .embeddings directory found");
        return Ok("[]".to_string());
    }
    
    let mut all_embeddings = Vec::new();
    
    // Recursively walk through .embeddings directory
    fn walk_embeddings(
        dir: &std::path::Path,
        base_path: &std::path::Path,
        embeddings: &mut Vec<serde_json::Value>,
    ) -> Result<(), String> {
        if !dir.is_dir() {
            return Ok(());
        }
        
        let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
        
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            
            if path.is_dir() {
                walk_embeddings(&path, base_path, embeddings)?;
            } else if path.extension().and_then(|s| s.to_str()) == Some("json") {
                // Read embedding file
                let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
                let embedding_data: serde_json::Value = serde_json::from_str(&content)
                    .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))?;
                
                // Calculate relative path from .embeddings/ and convert to notes/ path
                let mut relative_path = path
                    .strip_prefix(base_path)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .to_string();
                if relative_path.ends_with(".json") {
                    relative_path = relative_path.trim_end_matches(".json").to_string();
                    relative_path.push_str(".md");
                }
                let note_path = embedding_data
                    .get("note_path")
                    .and_then(|v| v.as_str())
                    .map(|s| normalize_note_path(s))
                    .filter(|s| !s.is_empty())
                    .unwrap_or(relative_path);
                
                // Extract embedding array and metadata
                let embedding_vec = embedding_data
                    .get("embedding")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                
                let model = embedding_data
                    .get("model")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                
                let created_at = embedding_data
                    .get("created_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let content_hash = embedding_data
                    .get("content_hash")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let chunks = embedding_data
                    .get("chunks")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!([]));
                
                // Create structured object with path, embedding array, and metadata
                let combined = serde_json::json!({
                    "path": note_path,
                    "embedding": embedding_vec,
                    "model": model,
                    "created_at": created_at,
                    "content_hash": content_hash,
                    "chunks": chunks,
                });
                
                embeddings.push(combined);
            }
        }
        
        Ok(())
    }
    
    walk_embeddings(&embeddings_dir, &embeddings_dir, &mut all_embeddings)?;
    
    println!("✅ Rust: Found {} embeddings", all_embeddings.len());
    
    serde_json::to_string(&all_embeddings).map_err(|e| e.to_string())
}

#[tauri::command]
fn search_semantic_embeddings(
    app_handle: tauri::AppHandle,
    query_embedding: Vec<f64>,
    limit: Option<usize>,
) -> Result<Vec<SemanticSearchHit>, String> {
    if query_embedding.is_empty() {
        return Ok(Vec::new());
    }

    let vault_path = get_vault_path(&app_handle)?;
    let max_results = limit.unwrap_or(12).clamp(1, 200);
    let state = app_handle.state::<AppState>();
    let should_rebuild = {
        let cache_guard = state.semantic_cache.lock().map_err(|e| e.to_string())?;
        cache_guard
            .as_ref()
            .map(|cache| cache.vault_path != vault_path)
            .unwrap_or(true)
    };

    {
        let mut stats = state.semantic_cache_stats.lock().map_err(|e| e.to_string())?;
        stats.queries += 1;
        if should_rebuild {
            stats.misses += 1;
        } else {
            stats.hits += 1;
        }
    }

    if should_rebuild {
        let rebuilt = build_semantic_cache(&vault_path)?;
        let entry_count = rebuilt.entries.len();
        let mut cache_guard = state.semantic_cache.lock().map_err(|e| e.to_string())?;
        *cache_guard = Some(rebuilt);
        let mut stats = state.semantic_cache_stats.lock().map_err(|e| e.to_string())?;
        stats.rebuilds += 1;
        stats.entries = entry_count;
        stats.last_built_at = Some(chrono::Utc::now().to_rfc3339());
    }

    let cache_guard = state.semantic_cache.lock().map_err(|e| e.to_string())?;
    let cache = match cache_guard.as_ref() {
        Some(value) => value,
        None => return Ok(Vec::new()),
    };

    if cache.entries.is_empty() {
        return Ok(Vec::new());
    }

    let mut hits: Vec<SemanticSearchHit> = Vec::with_capacity(cache.entries.len());
    for entry in &cache.entries {
        let mut best_similarity = -1.0_f64;
        let mut best_snippet: Option<String> = None;

        if let Some(base_embedding) = entry.embedding.as_ref() {
            if let Some(score) = cosine_similarity(&query_embedding, base_embedding) {
                best_similarity = score;
            }
        }

        for chunk in &entry.chunks {
            let score = cosine_similarity(&query_embedding, &chunk.embedding);
            if let Some(similarity) = score {
                if similarity > best_similarity {
                    best_similarity = similarity;
                    best_snippet = chunk.excerpt.clone();
                }
            }
        }

        if best_similarity < 0.0 {
            continue;
        }

        hits.push(SemanticSearchHit {
            path: entry.path.clone(),
            similarity: best_similarity,
            snippet: best_snippet,
        });
    }
    drop(cache_guard);

    hits.sort_by(|a, b| {
        b.similarity
            .partial_cmp(&a.similarity)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.path.cmp(&b.path))
    });
    hits.truncate(max_results);
    Ok(hits)
}

#[tauri::command]
fn get_semantic_cache_stats(app_handle: tauri::AppHandle) -> Result<SemanticCacheStats, String> {
    let state = app_handle.state::<AppState>();
    let stats_snapshot = {
        let stats = state.semantic_cache_stats.lock().map_err(|e| e.to_string())?;
        stats.clone()
    };
    if stats_snapshot.entries > 0 {
        return Ok(stats_snapshot);
    }

    let cache_entries = {
        let cache = state.semantic_cache.lock().map_err(|e| e.to_string())?;
        cache.as_ref().map(|value| value.entries.len()).unwrap_or(0)
    };
    if cache_entries > 0 {
        let mut stats = state.semantic_cache_stats.lock().map_err(|e| e.to_string())?;
        stats.entries = cache_entries;
        return Ok(stats.clone());
    }
    Ok(stats_snapshot)
}

#[tauri::command]
fn clear_all_embeddings(app_handle: tauri::AppHandle) -> Result<(), String> {
    println!("🗑️  Rust: Clearing all embeddings...");

    let vault_path = get_vault_path(&app_handle)?;
    let embeddings_dir = vault_path.join(".embeddings");
    
    if embeddings_dir.exists() {
        println!("📁 Rust: Deleting embeddings directory: {:?}", embeddings_dir);
        fs::remove_dir_all(&embeddings_dir).map_err(|e| e.to_string())?;
    }
    
    // Recreate empty .embeddings directory
    fs::create_dir_all(&embeddings_dir).map_err(|e| e.to_string())?;
    
    println!("✅ Rust: All embeddings cleared successfully!");
    invalidate_semantic_cache(&app_handle);
    Ok(())
}

#[tauri::command]
fn search_notes(app_handle: tauri::AppHandle, query: String, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
    let vault_path = get_vault_path(&app_handle)?;
    let trimmed_query = query.trim().to_lowercase();
    if trimmed_query.is_empty() {
        return Ok(Vec::new());
    }
    let max_results = limit.unwrap_or(40).clamp(1, 200);
    let tokens: Vec<String> = trimmed_query
        .split_whitespace()
        .map(|t| t.to_string())
        .filter(|t| !t.is_empty())
        .collect();

    fn should_skip_name(name: &str) -> bool {
        name.starts_with('.')
            || name == ".embeddings"
            || name == "index.json"
            || name == "embeddings.json"
            || name == ".index.json"
            || name == ".embeddings.json"
    }

    fn make_snippet(content: &str, query: &str, tokens: &[String]) -> String {
        let content_one_line = content.replace('\n', " ");
        let lower = content_one_line.to_lowercase();
        let mut idx = lower.find(query).unwrap_or(usize::MAX);
        if idx == usize::MAX {
            for token in tokens {
                if let Some(found) = lower.find(token) {
                    idx = found;
                    break;
                }
            }
        }
        let (start, end) = if idx != usize::MAX {
            (idx.saturating_sub(70), (idx + 140).min(content_one_line.len()))
        } else {
            (0, content_one_line.len().min(180))
        };
        let mut safe_start = start.min(content_one_line.len());
        let mut safe_end = end.min(content_one_line.len());

        while safe_start > 0 && !content_one_line.is_char_boundary(safe_start) {
            safe_start -= 1;
        }
        while safe_end < content_one_line.len() && !content_one_line.is_char_boundary(safe_end) {
            safe_end += 1;
        }
        if safe_end < safe_start {
            safe_end = safe_start;
        }

        content_one_line[safe_start..safe_end].trim().to_string()
    }

    fn walk(
        dir: &std::path::Path,
        base: &std::path::Path,
        query: &str,
        tokens: &[String],
        hits: &mut Vec<SearchHit>,
    ) -> Result<(), String> {
        if !dir.is_dir() {
            return Ok(());
        }

        let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();

            if should_skip_name(&file_name) {
                continue;
            }

            if path.is_dir() {
                walk(&path, base, query, tokens, hits)?;
                continue;
            }

            let relative_path = path
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string();

            let lower_name = file_name.to_lowercase();
            let lower_path = relative_path.to_lowercase();
            let content = match read_ai_readable_content(&path) {
                Ok(result) => result.content,
                Err(_) => continue,
            };
            let lower_content = content.to_lowercase();

            let mut score = 0_i32;
            if lower_name.contains(query) {
                score += 120;
            }
            if lower_path.contains(query) {
                score += 60;
            }
            if lower_content.contains(query) {
                score += 40;
            }

            for token in tokens {
                if lower_name.contains(token) {
                    score += 20;
                }
                if lower_path.contains(token) {
                    score += 10;
                }
                if lower_content.contains(token) {
                    score += 4;
                }
            }

            if score <= 0 {
                continue;
            }

            let title = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&file_name)
                .to_string();
            let snippet = make_snippet(&content, query, tokens);

            hits.push(SearchHit {
                path: relative_path,
                title,
                snippet,
                score,
            });
        }

        Ok(())
    }

    let mut hits: Vec<SearchHit> = Vec::new();
    walk(&vault_path, &vault_path, &trimmed_query, &tokens, &mut hits)?;

    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    hits.truncate(max_results);
    Ok(hits)
}

#[tauri::command]
async fn local_ai_list_models(provider: String, base_url: String) -> Result<Vec<LocalAiModelResponse>, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let normalized_provider = provider.to_lowercase();
    if normalized_provider == "lmstudio" {
        let value = local_ai_get_json(&client, "LM Studio", &base_url, "/v1/models").await?;
        let models = value
            .get("data")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| item.get("id").and_then(|v| v.as_str()).map(|name| name.trim().to_string()))
            .filter(|name| !name.is_empty())
            .map(|name| {
                let lower = name.to_lowercase();
                let looks_embedding = lower.contains("embed") || lower.contains("embedding") || lower.contains("nomic-embed") || lower.contains("bge") || lower.contains("mxbai");
                let looks_text = lower.contains("gpt") || lower.contains("llama") || lower.contains("qwen") || lower.contains("mistral") || lower.contains("phi") || lower.contains("gemma") || lower.contains("deepseek") || lower.contains("chat");
                let (capability, capabilities) = if looks_embedding && looks_text {
                    ("both".to_string(), vec!["completion".to_string(), "embedding".to_string()])
                } else if looks_embedding {
                    ("embedding".to_string(), vec!["embedding".to_string()])
                } else if looks_text {
                    ("text".to_string(), vec!["completion".to_string()])
                } else {
                    ("unknown".to_string(), Vec::new())
                };
                LocalAiModelResponse {
                    name,
                    size: None,
                    modified_at: None,
                    capability,
                    capabilities,
                }
            })
            .collect();
        return Ok(models);
    }

    let value = local_ai_get_json(&client, "Ollama", &base_url, "/api/tags").await?;
    let models = value
        .get("models")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .or_else(|| item.get("model").and_then(|v| v.as_str()))
                .unwrap_or("")
                .trim()
                .to_string();
            if name.is_empty() {
                return None;
            }
            let lower = name.to_lowercase();
            let looks_embedding = lower.contains("embed") || lower.contains("embedding") || lower.contains("nomic-embed") || lower.contains("bge") || lower.contains("mxbai");
            let looks_text = lower.contains("gpt") || lower.contains("llama") || lower.contains("qwen") || lower.contains("mistral") || lower.contains("phi") || lower.contains("gemma") || lower.contains("deepseek") || lower.contains("chat");
            let (capability, capabilities) = if looks_embedding && looks_text {
                ("both".to_string(), vec!["completion".to_string(), "embedding".to_string()])
            } else if looks_embedding {
                ("embedding".to_string(), vec!["embedding".to_string()])
            } else if looks_text {
                ("text".to_string(), vec!["completion".to_string()])
            } else {
                ("unknown".to_string(), Vec::new())
            };

            Some(LocalAiModelResponse {
                name,
                size: item.get("size").and_then(|v| v.as_u64()),
                modified_at: item.get("modified_at").and_then(|v| v.as_str()).map(|v| v.to_string()),
                capability,
                capabilities,
            })
        })
        .collect();
    Ok(models)
}

#[tauri::command]
async fn local_ai_generate_text(
    provider: String,
    base_url: String,
    model: String,
    prompt: String,
    json_preferred: bool,
    temperature: Option<f64>,
    num_predict: Option<u32>,
    top_p: Option<f64>,
    repeat_penalty: Option<f64>,
    timeout_ms: Option<u64>,
) -> Result<LocalAiTextResponse, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms.unwrap_or(30000)))
        .build()
        .map_err(|e| e.to_string())?;

    let normalized_provider = provider.to_lowercase();
    if normalized_provider == "lmstudio" {
        let make_body = |include_json_format: bool| {
            let mut body = serde_json::Map::new();
            body.insert("model".to_string(), serde_json::json!(model));
            body.insert(
                "messages".to_string(),
                serde_json::json!([{ "role": "user", "content": prompt }]),
            );
            body.insert("temperature".to_string(), serde_json::json!(temperature.unwrap_or(0.3)));
            body.insert("max_tokens".to_string(), serde_json::json!(num_predict.unwrap_or(300)));
            body.insert("top_p".to_string(), serde_json::json!(top_p.unwrap_or(0.9)));
            if include_json_format && json_preferred {
                body.insert(
                    "response_format".to_string(),
                    serde_json::json!({ "type": "json_object" }),
                );
            }
            serde_json::Value::Object(body)
        };

        let mut value = local_ai_post_json(&client, "LM Studio", &base_url, "/v1/chat/completions", make_body(true)).await;
        if value.is_err() && json_preferred {
            value = local_ai_post_json(&client, "LM Studio", &base_url, "/v1/chat/completions", make_body(false)).await;
        }
        let value = value?;
        let text = value
            .get("choices")
            .and_then(|v| v.as_array())
            .and_then(|items| items.first())
            .and_then(|item| item.get("message"))
            .and_then(|msg| msg.get("content"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        return Ok(LocalAiTextResponse { text });
    }

    let mut options = serde_json::Map::new();
    options.insert("temperature".to_string(), serde_json::json!(temperature.unwrap_or(0.3)));
    options.insert("num_predict".to_string(), serde_json::json!(num_predict.unwrap_or(300)));
    if let Some(value) = top_p {
        options.insert("top_p".to_string(), serde_json::json!(value));
    }
    if let Some(value) = repeat_penalty {
        options.insert("repeat_penalty".to_string(), serde_json::json!(value));
    }

    let mut body = serde_json::Map::new();
    body.insert("model".to_string(), serde_json::json!(model));
    body.insert("prompt".to_string(), serde_json::json!(prompt));
    body.insert("stream".to_string(), serde_json::json!(false));
    if json_preferred {
        body.insert("format".to_string(), serde_json::json!("json"));
    }
    body.insert("options".to_string(), serde_json::Value::Object(options));

    let value = local_ai_post_json(&client, "Ollama", &base_url, "/api/generate", serde_json::Value::Object(body)).await?;
    let text = value.get("response").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    Ok(LocalAiTextResponse { text })
}

#[tauri::command]
async fn local_ai_generate_embedding(
    provider: String,
    base_url: String,
    model: String,
    input: String,
    timeout_ms: Option<u64>,
) -> Result<LocalAiEmbeddingResponse, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms.unwrap_or(30000)))
        .build()
        .map_err(|e| e.to_string())?;

    let normalized_provider = provider.to_lowercase();
    let value = if normalized_provider == "lmstudio" {
        local_ai_post_json(&client, "LM Studio", &base_url, "/v1/embeddings", serde_json::json!({
            "model": model,
            "input": input,
        })).await?
    } else {
        local_ai_post_json(&client, "Ollama", &base_url, "/api/embeddings", serde_json::json!({
            "model": model,
            "prompt": input,
        })).await?
    };

    let embedding = if normalized_provider == "lmstudio" {
        value.get("data")
            .and_then(|v| v.as_array())
            .and_then(|items| items.first())
            .and_then(|item| item.get("embedding"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    } else {
        value.get("embedding").and_then(|v| v.as_array()).cloned().unwrap_or_default()
    };

    let vector = embedding
        .into_iter()
        .filter_map(|value| value.as_f64())
        .collect::<Vec<_>>();

    Ok(LocalAiEmbeddingResponse { embedding: vector })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
        init_vault,
        set_vault_path,
        read_vault_tree,
        read_file,
        read_file_for_ai,
        read_file_preview,
        write_file,
        delete_path,
        rename_path,
        create_file_in_folder,
        create_folder,
        write_embedding,
        delete_embedding,
        read_all_embeddings,
        search_semantic_embeddings,
        get_semantic_cache_stats,
        clear_all_embeddings,
        search_notes,
        local_ai_list_models,
        local_ai_generate_text,
        local_ai_generate_embedding
    ])
    .setup(|app| {
      app.manage(AppState {
          vault_path: Mutex::new(None),
          semantic_cache: Mutex::new(None),
          semantic_cache_stats: Mutex::new(SemanticCacheStats::new()),
      });
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
