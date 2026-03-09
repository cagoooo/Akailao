const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf8');
const lines = content.split('\n');

let out = '';
const log = (msg) => { out += msg + '\n'; };

const targets = ['submitReadingAnswer', 'renderReadingLeaderboard', 'renderLeaderboard', 'highlighter', 'bonus score', 'startTime', 'startReading', 'saveReadingAnswer', 'submitQuiz', 'timeSpent', 'bonus', '作答', '加分', '螢光筆'];
targets.forEach(t => {
    log(`\nMatches for ${t}:`);
    lines.forEach((line, i) => {
        if (line.toLowerCase().includes(t.toLowerCase())) {
            log(`${i + 1}: ${line.trim()}`);
            if (line.includes('function') || line.includes('=>')) {
                for (let j = 1; j <= 5; j++) {
                    if (lines[i + j]) {
                        log(`  ${i + 1 + j}: ${lines[i + j].trim()}`);
                    }
                }
            }
        }
    });
});

fs.writeFileSync('output8.txt', out, 'utf8');
