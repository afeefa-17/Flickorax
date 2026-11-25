# Flickorax

**Find what to watch, solo or together.**

Demo video: *Add your demo video link here.*

## Features

- **Find Content:** Choose from content type, language, genres, mood, release period, duration, rating, country, and story preferences. Filters are optional, so you can personalise your recommendations.
- **Surprise Me:** Not sure what to watch? Get a recommendation without filling in the full preferences form.
- **Watch Party:** Create or join a room and discover titles for your group. Rooms support up to 10 members and expire after 15 hours. Members can add their preferences so the recommendations can suit the group.
- **Watchlist:** Save titles to your watchlist and get **“Because you liked…”** recommendations.
- **Optional Login:** Guests can use solo recommendations, Surprise Me, and Watch Party. Logging in lets you save your watchlist and preferences.

## Tech Stack

- **Frontend:** React, TypeScript, Vite, Tailwind CSS
- **Backend:** Node.js, Express
- **AI:** Google Gemini
- **Movie and anime data:** TMDB and AniList
- **Login and storage:** Firebase

## How to Run

### Prerequisites

- Node.js (LTS version)
- API keys for Google Gemini and TMDB

### Setup

1. Clone or download this repository and open a terminal in the project folder.
2. Install the dependencies:

   ```bash
   npm install
   ```

3. Create a `.env` file by copying `.env.example`:

   ```bash
   cp .env.example .env
   ```

   On Windows, you can also copy `.env.example` and rename the copy to `.env`.

4. Add your API keys to `.env`:

   - `GEMINI_API_KEY` — get a key from [Google AI Studio](https://aistudio.google.com/).
   - `TMDB_API_KEY` — get an API key from [TMDB](https://www.themoviedb.org/settings/api).
   - `APP_URL` — optional for local development; set this to the deployed app URL when deploying.

5. Start the development server:

   ```bash
   npm run dev
   ```

6. Open **http://localhost:3000** in your browser.

## Project Structure

```text
.
├── server.ts                 # Express server and API routes
├── server/                   # Gemini, media data, authentication, and Watch Party logic
├── src/
│   ├── pages/                # Home, Find Content, Surprise Me, Watch Party, Watchlist
│   ├── components/           # Navbar, cards, forms, modals, and shared UI
│   ├── contexts/             # Authentication context
│   ├── services/             # Recommendation, catalog, and Watch Party services
│   ├── data/                 # Fallback preference options
│   ├── lib/                  # Firebase setup
│   └── types/                # TypeScript types
├── firestore.rules           # Firebase security rules
├── .env.example              # Example environment variables
└── package.json              # Project dependencies and scripts
```

## Notes

- Keep API keys and other secrets in your local `.env` file. **Never upload `.env` to GitHub.**
- The `.env.example` file contains placeholders only; replace them in your local `.env` file.
- Firebase features require the corresponding Firebase project configuration.
