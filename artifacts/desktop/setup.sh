#!/bin/bash
# Noah Desktop — Setup Script
# Run this on your Mac to install dependencies and launch the app

set -e

echo "🚀 Setting up Noah Desktop..."

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Please install from https://nodejs.org"
  exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

echo ""
echo "✅ Setup complete!"
echo ""
echo "To run the app:"
echo "  npm run dev"
echo ""
echo "To build a distributable .dmg:"
echo "  npm run build:dmg"
echo ""
echo "📝 Before running, make sure .env is filled in with your Firebase config."
