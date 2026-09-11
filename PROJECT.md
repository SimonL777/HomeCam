# HomeCam Architecture

## Goal

HomeCam provides a small, self-hosted video monitoring stack built from common
hardware and open media protocols. The capture device publishes video, while a
separate server owns live playback, recording storage, retention, and the web
interface.

## Components

| Component | Responsibility |
|---|---|
| USB camera | Supplies a V4L2 video stream. |
| Raspberry Pi publisher | Captures, encodes, and publishes H.264 over RTSP. |
| MediaMTX | Authenticates ingest, serves live media, and writes fMP4 recordings. |
| HomeCam web | Authenticates users and provides live view, playback, downloads, and settings. |
| Optional Pi controller | Applies a validated capture profile and restarts the publisher. |

```text
Camera -> Pi/FFmpeg -> RTSP -> MediaMTX -> WebRTC/HLS -> Browser
                                      `-> fMP4 recordings
```

## Trust boundaries

- The dashboard requires HTTP Basic authentication.
- The RTSP publisher uses separate credentials from dashboard users.
- MediaMTX HLS and WHEP HTTP ports are internal to the Compose network.
- WebRTC media uses a published UDP port after the authenticated WHEP exchange.
- Recording files are read-only inside the web container.
- The optional Pi controller requires a bearer token and can restrict requests
  to one server IP.
- HomeCam does not provide TLS. Deploy it on a trusted LAN or VPN, or behind an
  HTTPS reverse proxy.

## Live playback

Private IPv4 HTTP clients use WebRTC for lower latency. HTTPS, hostnames, and
non-private addresses use same-origin HLS through the web service. The browser
never receives the internal HLS CDN secret.

## Historical playback

MediaMTX recordings use fragmented MP4. Files that are still being written are
not always directly seekable in browsers, so the web service reads a bounded
snapshot and uses FFmpeg stream-copy to generate temporary HLS VOD fragments.

This process:

- does not transcode the video;
- does not modify the original recording;
- limits playback cache reservations to 3 GiB;
- allows only one conversion at a time;
- expires idle playback jobs after 30 minutes.

## Persistence

| Path | Purpose | Web access |
|---|---|---|
| `data/recordings` | MediaMTX fMP4 recordings | Read-only |
| `data/config/settings.json` | Retention and camera profile settings | Read-write |
| `/tmp/homecam-vod` | Temporary HLS playback cache | Read-write, ephemeral |

## Verification standard

A successful HTTP response alone does not prove that a recording is playable.
Playback verification should confirm:

- a finite duration;
- non-zero video dimensions;
- sufficient browser ready state;
- advancing playback time;
- seeking near the end and resuming playback.

## Roadmap

1. Multiple independently authenticated publishers.
2. Reverse-proxy examples for common self-hosted environments.
3. Camera offline, recording failure, and storage capacity alerts.
4. Optional motion detection and event indexing.
5. Backup and restore tooling for settings.
