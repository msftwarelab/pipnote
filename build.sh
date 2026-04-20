#!/bin/bash

# Pipnote Build Script
# Builds distributable packages for macOS, Windows, and Linux

set -e  # Exit on error

echo "🚀 Pipnote Build Script v1.0.0"
echo "========================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check prerequisites
echo -e "\n${YELLOW}Checking prerequisites...${NC}"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js not found. Please install Node.js 18+${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${NC}"

# Check pnpm
if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}❌ pnpm not found. Install with: npm install -g pnpm${NC}"
    exit 1
fi
echo -e "${GREEN}✓ pnpm $(pnpm --version)${NC}"

# Check Rust
if ! command -v cargo &> /dev/null; then
    echo -e "${RED}❌ Rust not found. Install from: https://rustup.rs${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Rust $(rustc --version)${NC}"

# Detect platform
PLATFORM=$(uname -s)
echo -e "\n${YELLOW}Platform: $PLATFORM${NC}"

# Install dependencies
echo -e "\n${YELLOW}Installing dependencies...${NC}"
pnpm install

# Build frontend
echo -e "\n${YELLOW}Building frontend...${NC}"
pnpm build

# Build Tauri app
echo -e "\n${YELLOW}Building Tauri application...${NC}"

if [ "$PLATFORM" == "Darwin" ]; then
    echo -e "${YELLOW}Building macOS universal binary...${NC}"
    pnpm tauri build --target universal-apple-darwin
    
    echo -e "\n${GREEN}✅ Build complete!${NC}"
    echo -e "${GREEN}📦 Installer: src-tauri/target/universal-apple-darwin/release/bundle/dmg/VN_1.0.0_universal.dmg${NC}"
    
    # Show file size
    if [ -f "src-tauri/target/universal-apple-darwin/release/bundle/dmg/VN_1.0.0_universal.dmg" ]; then
        SIZE=$(du -h "src-tauri/target/universal-apple-darwin/release/bundle/dmg/VN_1.0.0_universal.dmg" | cut -f1)
        echo -e "${GREEN}📊 Size: $SIZE${NC}"
    fi
    
elif [ "$PLATFORM" == "Linux" ]; then
    echo -e "${YELLOW}Building Linux packages...${NC}"
    pnpm tauri build
    
    echo -e "\n${GREEN}✅ Build complete!${NC}"
    echo -e "${GREEN}📦 Packages:${NC}"
    ls -lh src-tauri/target/release/bundle/deb/*.deb 2>/dev/null || true
    ls -lh src-tauri/target/release/bundle/appimage/*.AppImage 2>/dev/null || true
    
elif [ "$PLATFORM" == "MINGW"* ] || [ "$PLATFORM" == "MSYS"* ]; then
    echo -e "${YELLOW}Building Windows installer...${NC}"
    pnpm tauri build --target x86_64-pc-windows-msvc
    
    echo -e "\n${GREEN}✅ Build complete!${NC}"
    echo -e "${GREEN}📦 Installer: src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/VN_1.0.0_x64_en-US.msi${NC}"
else
    echo -e "${RED}❌ Unsupported platform: $PLATFORM${NC}"
    exit 1
fi

echo -e "\n${YELLOW}Next steps:${NC}"
echo "1. Test the installer on target platform"
echo "2. Verify Ollama integration works"
echo "3. Distribute to users"
echo ""
echo -e "${YELLOW}Note: Users need Ollama with gpt-oss:120b-cloud and nomic-embed-text models${NC}"
