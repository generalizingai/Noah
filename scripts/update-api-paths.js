#!/usr/bin/env node

// Script to update all /api/omi references to /api/noah in TypeScript files

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Find all TypeScript/TSX files in the artifacts directory
const files = execSync('find artifacts -name "*.ts" -o -name "*.tsx" | grep -v node_modules | grep -v ".next" | grep -v "dist"', {
  cwd: '/Users/Hamzaa/Documents/Claude Code/Noah AI',
  encoding: 'utf8'
}).split('\n').filter(Boolean);

console.log(`Found ${files.length} TypeScript/TSX files to check`);

const updates = [];

files.forEach(file => {
  const filePath = `/Users/Hamzaa/Documents/Claude Code/Noah AI/${file}`;
  const content = fs.readFileSync(filePath, 'utf8');

  // Check for /api/omi references
  if (content.includes('/api/omi')) {
    // Count occurrences
    const count = (content.match(/\/api\/omi/g) || []).length;
    console.log(`Found ${count} /api/omi references in ${file}`);

    // Replace all occurrences
    const updatedContent = content.replace(/\/api\/omi/g, '/api/noah');

    // Check if content changed
    if (updatedContent !== content) {
      // Backup original
      const backupPath = filePath + '.backup';
      fs.writeFileSync(backupPath, content);

      // Write updated content
      fs.writeFileSync(filePath, updatedContent);

      updates.push({
        file: file,
        count: count,
        backup: backupPath
      });
    }
  }
});

console.log(`\nUpdated ${updates.length} files:`);
updates.forEach(update => {
  console.log(`- ${update.file} (${update.count} references)`);
});

console.log('\nAll updates complete!');