# LinkedIn Salary Insights (levels.fyi)

A Chrome extension that shows real salary data from levels.fyi directly on LinkedIn job postings.

## Features

- 🎯 **Automatic Detection**: Extracts job title and company from LinkedIn job postings
- 💰 **Real Salary Data**: Fetches compensation data from levels.fyi
- 📊 **Statistical Insights**: Shows median TC, average base, P25, and P75 percentiles
- 🔄 **Multiple Fallbacks**: Robust data fetching with multiple fallback strategies
- 🎨 **Clean UI**: Beautiful, non-intrusive widget that integrates seamlessly with LinkedIn

## Installation

### From Source

1. Clone this repository:
   ```bash
   git clone https://github.com/marshal4world/LinkedInSalaryLevelsFYIExtension.git
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable "Developer mode" (toggle in top right)

4. Click "Load unpacked" and select the extension directory

5. Navigate to any LinkedIn job posting to see salary insights!

## How It Works

1. **Job Detection**: The extension monitors LinkedIn job pages and extracts:
   - Job title from the page title or heading elements
   - Company name from company links
   - Job ID from the URL (as fallback)

2. **Data Fetching**: Multiple strategies to get salary data:
   - Direct salary page scraping from levels.fyi
   - Legacy API endpoints
   - Company page fallback with HTML extraction
   - __NEXT_DATA__ JSON extraction

3. **Data Processing**:
   - Normalizes job titles (removes team/domain qualifiers)
   - Calculates statistics (P25, median, P75, average base)
   - Handles various compensation field formats

4. **Display**: Shows a clean widget with:
   - Salary statistics
   - Number of data points
   - Link to full levels.fyi data

## Technical Details

### Architecture

- **content.js**: Runs on LinkedIn pages, handles UI and job detection
- **background.js**: Service worker that performs cross-origin requests to levels.fyi
- **styles.css**: Widget styling
- **manifest.json**: Extension configuration

### Data Sources

The extension tries multiple data sources in order:
1. `https://www.levels.fyi/companies/{company}/salaries/{title}` - Direct salary page
2. `https://www.levels.fyi/api/v2/salary/` - API v2 endpoint
3. `https://www.levels.fyi/api/salaries` - Legacy API endpoint
4. `https://www.levels.fyi/companies/{company}/salaries` - Company page fallback

### Permissions

- `storage`: For caching preferences (future use)
- `https://www.linkedin.com/*`: To access LinkedIn job pages
- `https://www.levels.fyi/*`: To fetch salary data

## Development

### Project Structure

```
.
├── background.js       # Service worker for API calls
├── content.js         # Content script for LinkedIn pages
├── styles.css         # Widget styles
├── manifest.json      # Extension manifest
├── icons/            # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md         # This file
```

### Building

No build step required! This is a pure JavaScript extension.

### Testing

1. Load the extension in Chrome
2. Navigate to a LinkedIn job posting
3. Check the browser console for diagnostic logs
4. The widget should appear below the job title

### Debugging

Enable console logging to see detailed diagnostics:
- Job extraction attempts
- API request/response details
- Data parsing results

Look for logs prefixed with `[LvlSalary]`

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - feel free to use and modify as needed.

## Acknowledgments

- Salary data provided by [levels.fyi](https://www.levels.fyi)
- Built for the developer community to promote salary transparency

## Disclaimer

This extension is not affiliated with or endorsed by LinkedIn or levels.fyi. It's an independent tool built to help job seekers make informed decisions.

## Attribution

Data sourced from Levels.fyi (https://www.levels.fyi). Content has been rephrased for compliance with licensing restrictions.
