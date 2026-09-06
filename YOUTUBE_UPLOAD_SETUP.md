# YouTube Upload Setup Guide

This guide explains how to configure YouTube API credentials for automated video uploads.

## Prerequisites

- A Google account
- Access to [Google Cloud Console](https://console.cloud.google.com/)

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Select a project" → "New Project"
3. Name your project (e.g., "Kids Content Generator")
4. Click "Create"

## Step 2: Enable YouTube Data API v3

1. In your project, go to "APIs & Services" → "Library"
2. Search for "YouTube Data API v3"
3. Click on it and press "Enable"

## Step 3: Create OAuth 2.0 Credentials

1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth client ID"
3. If prompted, configure the OAuth consent screen:
   - User Type: External
   - App name: Your app name
   - User support email: Your email
   - Developer contact: Your email
   - Add scopes: `https://www.googleapis.com/auth/youtube.upload`
   - Add test users: Your Google account email
4. Back in Credentials, create OAuth client ID:
   - Application type: **Desktop app**
   - Name: "Content Generator Desktop"
5. Click "Create"
6. **Save the Client ID and Client Secret** (you'll need these)

## Step 4: Get a Refresh Token

You need to exchange an authorization code for a refresh token. Use this Node.js script:

```javascript
// get-youtube-token.js
import { google } from 'googleapis';
import readline from 'readline';

const CLIENT_ID = 'YOUR_CLIENT_ID';
const CLIENT_SECRET = 'YOUR_CLIENT_SECRET';
const REDIRECT_URI = 'http://localhost';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // Force to get refresh token
});

console.log('Authorize this app by visiting this URL:', authUrl);
console.log('\nAfter authorization, you will be redirected to a URL.');
console.log('Copy the ENTIRE URL from your browser address bar and paste it here:\n');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Enter the full redirect URL: ', async (redirectUrl) => {
  try {
    const url = new URL(redirectUrl);
    const code = url.searchParams.get('code');
    
    if (!code) {
      throw new Error('No authorization code found in URL');
    }

    const { tokens } = await oauth2Client.getToken(code);
    console.log('\n✅ Success! Add these to your .env file:\n');
    console.log(`YOUTUBE_CLIENT_ID=${CLIENT_ID}`);
    console.log(`YOUTUBE_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
  } catch (error) {
    console.error('Error:', error.message);
  }
  rl.close();
});
```

Run it:
```bash
node get-youtube-token.js
```

1. Visit the URL it prints
2. Sign in with your Google account
3. Grant permissions
4. Copy the **entire URL** from your browser after redirect (even if it shows an error page)
5. Paste it into the terminal
6. Copy the refresh token it outputs

## Step 5: Update .env File

Add to your `.env` file:

```bash
YOUTUBE_CLIENT_ID=your-client-id.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=your-client-secret
YOUTUBE_REFRESH_TOKEN=your-refresh-token
```

## Step 6: Test Upload

The `upload_to_youtube` tool is now available. It will:

- Upload videos to your YouTube channel
- Set title, description, and tags
- Mark videos as "Made for Kids" (COPPA compliance)
- Reuse a durable upload receipt on reruns instead of intentionally uploading a duplicate
- Let YouTube select a video frame automatically unless an explicit custom thumbnail is supplied
- Default tags: "Children stories", "stories for kids", "stories for children"

Example usage in the agent:
```
After video assembly, upload to YouTube with:
- Title: "Tiny Heroes Club - Episode 1: The Kite Rescue"
- Description: "Join Pip and friends in their first adventure!"
- Thumbnail: Omit it so YouTube selects a frame, or provide a separately prepared custom image
- Privacy: public
```

Production no longer generates series key art, episode key art, or scene
images. Legacy key-art files on disk are not production thumbnail inputs.

## Troubleshooting

### "Invalid grant" error
- Your refresh token may have expired or been revoked
- Re-run the token script to get a new refresh token

### "Quota exceeded" error
- YouTube API has daily upload quotas
- Default quota: 10,000 units/day (1 upload ≈ 1,600 units)
- Request quota increase in Google Cloud Console if needed

### "Video is not made for kids" warning
- The tool automatically sets `selfDeclaredMadeForKids: true`
- This is required for children's content per COPPA

## Security Notes

- **Never commit** your `.env` file to version control
- Refresh tokens don't expire unless revoked
- Keep your Client Secret secure
- Revoke access in Google Account settings if compromised
