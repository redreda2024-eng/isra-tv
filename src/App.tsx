import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { APP_VERSION } from './app-version'
import {
  deleteNativePlaylist,
  getNativePlaylist,
  getNativePlaylists,
  saveNativePlaylist,
  updateNativePlaylist,
} from './native-playlist-storage'
import type HlsPlayer from 'hls.js'
import type Mpegts from 'mpegts.js'
import {
  ArrowLeft,
  Captions,
  CircleDot,
  Clock3,
  Film,
  FolderOpen,
  Gauge,
  Heart,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  LayoutGrid,
  Link,
  ListVideo,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Server,
  Star,
  Trash2,
  Tv,
  User,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import './App.css'

type Channel = {
  id: string
  name: string
  group: string
  logo: string
  stream: string
  epg: string
  quality: string
  isLive: boolean
  isFavorite: boolean
  mediaType?: 'live' | 'movie' | 'series' | 'episode'
  seriesId?: string
  tvgId?: string
  epgId?: string
  details?: {
    year?: string
    releaseDate?: string
    duration?: string
    genre?: string
    director?: string
    cast?: string
    rating?: string
  }
}

type EpgProgram = {
  id: string
  title: string
  description: string
  start: number // Unix timestamp
  stop: number // Unix timestamp
  channelId: string
}

function getVodInformation(channel: Channel) {
  const details = channel.details
  const year = details?.year ?? details?.releaseDate?.match(/\b(?:19|20)\d{2}\b/)?.[0]
  return [
    ['Date de sortie', details?.releaseDate],
    ['Année', year],
    ['Genre', details?.genre],
    ['Durée', details?.duration],
    ['Réalisation', details?.director],
    ['Distribution', details?.cast],
    ['Note', details?.rating],
  ].filter(([, value]) => Boolean(value))
}

const channelMediaTypeCache = new WeakMap<Channel, 'live' | 'movie' | 'series'>()

function getChannelMediaType(channel: Channel): 'live' | 'movie' | 'series' {
  // 300 000 chaînes : normaliser le nom à chaque filtre figeait l'application. Le type est
  // calculé une seule fois par objet (les mises à jour créent un nouvel objet).
  const cached = channelMediaTypeCache.get(channel)
  if (cached) return cached

  let mediaType: 'live' | 'movie' | 'series' = 'live'
  if (channel.mediaType === 'movie') mediaType = 'movie'
  else if (channel.mediaType === 'series' || channel.mediaType === 'episode') mediaType = 'series'
  else if (channel.mediaType !== 'live' && !channel.isLive) {
    const label = `${channel.group} ${channel.name}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    if (/\b(film|films|movie|movies|cinema|vod)\b/.test(label)) mediaType = 'movie'
    else if (/\b(series|serie|tv shows?)\b/.test(label)) mediaType = 'series'
  }
  channelMediaTypeCache.set(channel, mediaType)
  return mediaType
}

// Répartition live / films / séries calculée une fois par liste de chaînes : sans ce cache,
// chaque changement d'onglet rescannait les 300 000 chaînes.
const mediaTypeBucketsCache = new WeakMap<readonly Channel[], {
  live: Channel[]
  movie: Channel[]
  series: Channel[]
}>()

function getMediaTypeBuckets(list: readonly Channel[]) {
  const cached = mediaTypeBucketsCache.get(list)
  if (cached) return cached
  const buckets = { live: [] as Channel[], movie: [] as Channel[], series: [] as Channel[] }
  for (const channel of list) buckets[getChannelMediaType(channel)].push(channel)
  mediaTypeBucketsCache.set(list, buckets)
  return buckets
}

const CHANNEL_ROW_HEIGHT = 90
const CHANNEL_OVERSCAN = 8

// Libellé de recherche calculé une seule fois par chaîne : sur 300 000 chaînes, normaliser
// chaque nom à chaque frappe figeait l'interface (et la table complète était reconstruite à
// chaque changement de source, donc à chaque caractère saisi).
const channelLabelCache = new WeakMap<Channel, string>()

function getChannelLabel(channel: Channel) {
  const cached = channelLabelCache.get(channel)
  if (cached !== undefined) return cached
  const label = `${channel.name} ${channel.group}`.toLowerCase()
  channelLabelCache.set(channel, label)
  return label
}

// Index id → chaîne : `channels.find(...)` parcourait 300 000 chaînes à chaque rendu.
const channelIndexCache = new WeakMap<readonly Channel[], Map<string, Channel>>()

function getChannelIndex(list: readonly Channel[]) {
  const cached = channelIndexCache.get(list)
  if (cached) return cached
  const index = new Map<string, Channel>()
  for (const channel of list) index.set(channel.id, channel)
  channelIndexCache.set(list, index)
  return index
}

const API_BASE_URL_KEY = 'iptv-api-base-url-v2'
const API_ACCESS_KEY = 'iptv-api-access-key'
const STREAM_TICKET_KEY = 'iptv-stream-ticket'
const DEFAULT_API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, '') ?? ''
// Même User-Agent que le serveur IPTV Hub : certains fournisseurs filtrent par navigateur.
const PROVIDER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'
// Route du proxy de flux natif Android (même comportement que /api/stream côté PC).
const NATIVE_STREAM_PATH = '/__stream'

function getApiBaseUrl() {
  return localStorage.getItem(API_BASE_URL_KEY)?.replace(/\/+$/, '') || DEFAULT_API_BASE_URL
}

function getApiAccessKey() {
  return localStorage.getItem(API_ACCESS_KEY) ?? ''
}

function apiUrl(path: string) {
  const baseUrl = getApiBaseUrl()
  return baseUrl ? new URL(path, `${baseUrl}/`).toString() : path
}

// URL absolue (origine locale Capacitor) : indispensable pour que le lecteur
// et son Web Worker puissent charger le flux sans blocage CORS.
function createNativeStreamUrl(stream: string) {
  return new URL(`${NATIVE_STREAM_PATH}?url=${encodeURIComponent(stream)}`, window.location.origin).toString()
}

function apiFetch(input: string, init?: RequestInit) {
  if (Capacitor.isNativePlatform() && !getApiBaseUrl()) {
    return nativeApiFetch(input, init)
  }

  const headers = new Headers(init?.headers)
  const accessKey = getApiAccessKey()
  if (accessKey) headers.set('X-IPTV-Access-Key', accessKey)
  return fetch(input, { ...init, headers })
}

type UserAccount = {
  id: string
  email: string
}

type Playlist = {
  id: string
  name: string
  createdAt: string
  channels: Channel[]
  sourceType?: 'file' | 'm3u' | 'xtream'
  m3uUrl?: string
  provider?: XtreamProvider
  suspended?: boolean
  customizations?: {
    channelNames: Record<string, string>
    groupNames: Record<string, string>
    hiddenGroups: string[]
    favoriteGroups: string[]
    hiddenChannels: string[]
    favoriteChannels: string[]
  }
}

type XtreamProvider = {
  server: string
  username: string
  password: string
}

type PlaylistSourceDetails = {
  sourceType: 'file' | 'm3u' | 'xtream'
  url: string
  server: string
  username: string
  password: string
}

type ItemContextMenuTarget =
  | { kind: 'group'; value: string }
  | { kind: 'channel'; value: Channel }
  | { kind: 'hidden-channel'; value: Channel }

type ItemContextMenu = ItemContextMenuTarget & {
  x: number
  y: number
}

type PlaybackState = {
  channelId: string
  mediaType: 'live' | 'movie' | 'episode'
  seriesId?: string
  seriesName?: string
  positions: Record<string, number>
  history: PlaybackHistoryEntry[]
}

type PlaybackHistoryEntry = {
  channelId: string
  name: string
  group: string
  logo: string
  quality: string
  mediaType: 'live' | 'movie' | 'episode'
  seriesId?: string
  seriesName?: string
  position: number
  updatedAt: number
}

function toHistoryEntry(
  channel: Channel,
  series?: { id: string; name: string },
  position = 0,
): PlaybackHistoryEntry {
  return {
    channelId: channel.id,
    name: channel.name,
    group: channel.group,
    logo: channel.logo,
    quality: channel.quality,
    mediaType: channel.mediaType === 'movie' || channel.mediaType === 'episode' ? channel.mediaType : 'live',
    ...(series ? { seriesId: series.id, seriesName: series.name } : {}),
    position,
    updatedAt: Date.now(),
  }
}

function addHistoryEntry(history: PlaybackHistoryEntry[], entry: PlaybackHistoryEntry) {
  return [entry, ...history.filter((item) => item.channelId !== entry.channelId)].slice(0, 100)
}

function formatPlaybackTime(seconds: number) {
  const totalSeconds = Math.floor(seconds)
  const minutes = Math.floor(totalSeconds / 60)
  const remainingSeconds = totalSeconds % 60
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`
}

function getPlaybackStateKey(userId: string, playlistId: string) {
  return `iptv-playback:${userId}:${playlistId}`
}

function getActivePlaylistKey(userId: string) {
  return `iptv-active-playlist:${userId}`
}

function getFavoritesKey(userId: string, playlistId: string) {
  return `iptv-favorites:${userId}:${playlistId}`
}

function readFavorites(key: string) {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function readPlaybackState(key: string): PlaybackState | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (
      !value ||
      typeof value !== 'object' ||
      !('channelId' in value) ||
      typeof value.channelId !== 'string' ||
      !('mediaType' in value) ||
      !['live', 'movie', 'episode'].includes(String(value.mediaType))
    ) {
      return null
    }
    const positions =
      'positions' in value && value.positions && typeof value.positions === 'object'
        ? Object.fromEntries(
            Object.entries(value.positions).filter(
              ([, position]) => typeof position === 'number' && Number.isFinite(position) && position > 0,
            ),
          )
        : {}
    const history =
      'history' in value && Array.isArray(value.history)
        ? value.history.filter((entry): entry is PlaybackHistoryEntry =>
            Boolean(
              entry &&
                typeof entry === 'object' &&
                'channelId' in entry &&
                typeof entry.channelId === 'string' &&
                'name' in entry &&
                typeof entry.name === 'string' &&
                'mediaType' in entry &&
                ['live', 'movie', 'episode'].includes(String(entry.mediaType)),
            ),
          )
        : []
    return {
      channelId: value.channelId,
      mediaType: value.mediaType as PlaybackState['mediaType'],
      ...('seriesId' in value && typeof value.seriesId === 'string' ? { seriesId: value.seriesId } : {}),
      ...('seriesName' in value && typeof value.seriesName === 'string' ? { seriesName: value.seriesName } : {}),
      positions,
      history,
    }
  } catch {
    return null
  }
}

function updatePlaybackState(key: string, update: (state: PlaybackState) => PlaybackState) {
  const current = readPlaybackState(key) ?? {
    channelId: '',
    mediaType: 'live' as const,
    positions: {},
    history: [],
  }
  localStorage.setItem(key, JSON.stringify(update(current)))
}

/* ---------- EPG Guide TV ---------- */
const EPG_HOURS_VISIBLE = 6
const EPG_SLOT_MINUTES = 30
const EPG_SLOTS = (EPG_HOURS_VISIBLE * 60) / EPG_SLOT_MINUTES

function formatEpgTime(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

function formatEpgDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' })
}

async function loadEpgForActivePlaylist(activePlaylistId: string) {
  if (!activePlaylistId) return
  try {
    const res = await apiFetch(apiUrl(`/api/playlists/${encodeURIComponent(activePlaylistId)}/epg`))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (data.epg) {
      const epgMap = new Map<string, EpgProgram[]>()
      for (const [channelId, programs] of Object.entries(data.epg)) {
        if (Array.isArray(programs)) {
          epgMap.set(channelId, programs as EpgProgram[])
        }
      }
      return epgMap
    }
  } catch (e) {
    console.warn('[EPG] Failed to load:', e)
  }
  return null
}

function getEpgForChannel(epgMap: Map<string, EpgProgram[]>, channelId: string, tvgId?: string, epgId?: string): EpgProgram[] {
  return epgMap.get(channelId) ?? epgMap.get(tvgId ?? '') ?? epgMap.get(epgId ?? '') ?? []
}

function getCurrentProgram(programs: EpgProgram[], now = Date.now() / 1000): EpgProgram | null {
  return programs.find(p => p.start <= now && p.stop >= now) ?? programs.find(p => p.start > now) ?? null
}

function setStartupPlaybackChannel(userId: string, playlistId: string, channels: Channel[]) {
  const channel =
    channels.find((item) => getChannelMediaType(item) === 'live') ?? channels[0]
  if (!channel) return

  updatePlaybackState(getPlaybackStateKey(userId, playlistId), (current) => ({
    ...current,
    channelId: channel.id,
    mediaType: getChannelMediaType(channel) === 'movie' ? 'movie' : 'live',
    seriesId: undefined,
    seriesName: undefined,
  }))
}

function setSubtitleTracksEnabled(tracks: TextTrackList, enabled: boolean) {
  let foundSubtitle = false
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]
    if (!track) continue
    const isSubtitle = track.kind === 'subtitles' || track.kind === 'captions'
    if (isSubtitle) {
      foundSubtitle = true
      track.mode = enabled ? 'showing' : 'disabled'
    }
  }
  return foundSubtitle
}

// Plus de chaînes de test : l'app démarre directement sur les playlists de l'utilisateur.
// Repli neutre affiché uniquement quand aucune playlist n'est chargée.
const EMPTY_CHANNEL: Channel = {
  id: '',
  name: 'Aucune chaîne',
  group: '',
  logo: '',
  stream: '',
  epg: '',
  quality: '',
  isLive: false,
  isFavorite: false,
}

const sidebarItems = [
  { label: 'TV en direct', icon: Tv },
  { label: 'Films', icon: Film },
  { label: 'Séries', icon: ListVideo },
  { label: 'Favoris', icon: Heart },
  { label: 'Historique', icon: Clock3 },
  { label: 'Enregistrements', icon: CircleDot },
  { label: 'Multi-écran', icon: LayoutGrid },
  { label: 'Playlists', icon: FolderOpen },
  { label: 'YouTube', icon: YoutubeLogo },
  { label: 'Test vitesse', icon: Gauge },
]

function YoutubeLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="5" fill="#ff0033" />
      <path d="M10 8.5v7l6-3.5z" fill="#fff" />
    </svg>
  )
}

const M3U_VIDEO_EXTENSION = /\.(mp4|m4v|mkv|avi|mov|flv|wmv|webm|mpg|mpeg|3gp)$/i
const M3U_LIVE_EXTENSION = /\.(m3u8?|ts)$/i

function normalizeM3uLabel(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

// Lit un attribut `clé="valeur"` d'une ligne #EXTINF (tvg-logo, group-title, tvg-name…).
function readM3uAttribute(line: string, attribute: string) {
  const match = line.match(new RegExp(`(?:^|[\\s,])${attribute}=("[^"]*"|'[^']*'|[^\\s,]*)`, 'i'))
  return match ? match[1].replace(/^["']|["']$/g, '').trim() : ''
}

// Détermine si l'entrée est une chaîne en direct, un film ou une série :
// d'abord les groupes (pays, VOD, films, séries…), puis l'extension du flux.
function detectM3uMediaType(group: string, name: string, stream: string): 'live' | 'movie' | 'series' {
  const groupLabel = normalizeM3uLabel(group)
  const nameLabel = normalizeM3uLabel(name)
  let path = stream.toLowerCase()
  try {
    path = new URL(stream).pathname.toLowerCase()
  } catch {
    // URL malformée : on teste la chaîne brute.
  }

  const dataExtension = M3U_VIDEO_EXTENSION.exec(path)?.[1]?.toLowerCase() ?? ''
  const isLiveFile = M3U_LIVE_EXTENSION.test(path)

  const isSeries = /\b(series?|serie|series tv|tv ?shows?|saisons?|seasons?)\b/.test(groupLabel) ||
    /\bs\d{1,2}\s*[-_. ]?e\d{1,3}\b/.test(nameLabel) ||
    /\b(saisons?|seasons?)\s*\d+/.test(nameLabel)
  if (isSeries) return 'series'

  const isMovieGroup = /\b(films?|movies?|cinema|vod|peliculas?|ficcion)\b/.test(groupLabel)
  // Une extension vidéo (mp4, mkv…) trahit un contenu à la demande, jamais un direct.
  if ((isMovieGroup && !isLiveFile) || (dataExtension && !isLiveFile)) return 'movie'

  return 'live'
}

function parseM3u(data: string): Channel[] {
  const channels: Channel[] = []
  const lines = data.split(/\r?\n/).map((line) => line.trim())

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    if (!line.startsWith('#EXTINF')) {
      continue
    }

    let streamIndex = index + 1
    while (streamIndex < lines.length && (!lines[streamIndex] || lines[streamIndex].startsWith('#'))) {
      if (lines[streamIndex].startsWith('#EXTINF')) break
      streamIndex += 1
    }
    const url = lines[streamIndex]
    if (!url || !/^https?:\/\//i.test(url)) {
      continue
    }

    const nameFromLine = line.match(/,(.*)$/)?.[1]?.trim() ?? ''
    const name = nameFromLine || readM3uAttribute(line, 'tvg-name') || 'Chaîne inconnue'
    const group = readM3uAttribute(line, 'group-title') || 'General'
    const logo = readM3uAttribute(line, 'tvg-logo') || readM3uAttribute(line, 'logo')
    const mediaType = detectM3uMediaType(group, name, url)

    channels.push({
      id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      name,
      group,
      logo: logo || (name
        .split(' ')
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('') || 'TV'),
      stream: url,
      epg: 'Imported playlist channel',
      quality: 'HD',
      isLive: mediaType === 'live',
      isFavorite: false,
      mediaType,
    })
    index = streamIndex
  }

  return channels
}

// Blob.text() manque sur certains WebView Android TV : repli sur FileReader.
function readFileAsText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('Impossible de lire ce fichier.'))
    reader.readAsText(file)
  })
}

function nativeJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function nativePublicPlaylist(playlist: Playlist) {
  const result = { ...playlist }
  delete result.provider
  delete result.m3uUrl
  result.sourceType ??= playlist.provider ? 'xtream' : playlist.m3uUrl ? 'm3u' : 'file'
  return result
}

function getNativeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Impossible de joindre le fournisseur IPTV.'
}

async function fetchNativeProviderText(url: string) {
  // Sur Android/TV box, un fetch classique est bloqué par CORS (le fournisseur n'envoie pas
  // d'en-têtes Access-Control-Allow-Origin). On passe donc par le client HTTP natif de Capacitor.
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url,
      method: 'GET',
      headers: { Accept: '*/*', 'User-Agent': PROVIDER_USER_AGENT },
      responseType: 'text',
      connectTimeout: 60_000,
      readTimeout: 60_000,
    })
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Le fournisseur IPTV a répondu avec l’erreur HTTP ${response.status}.`)
    }
    return typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
  }

  // Web / développement : AbortController car AbortSignal.timeout() manque sur les vieux WebView.
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timeoutId = controller ? setTimeout(() => controller.abort(), 60_000) : undefined
  try {
    const response = await fetch(url, {
      headers: { Accept: '*/*' },
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (!response.ok) {
      throw new Error(`Le fournisseur IPTV a répondu avec l’erreur HTTP ${response.status}.`)
    }
    return await response.text()
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

function createXtreamApiUrl(provider: XtreamProvider, action: string, extra?: Record<string, string>) {
  const url = new URL(provider.server)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('L’adresse Xtream doit commencer par http:// ou https://.')
  }
  url.search = ''
  url.hash = ''
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/player_api.php`
  url.searchParams.set('username', provider.username)
  url.searchParams.set('password', provider.password)
  url.searchParams.set('action', action)
  for (const [key, value] of Object.entries(extra ?? {})) url.searchParams.set(key, value)
  return url.toString()
}

function buildXtreamStreamUrl(
  provider: XtreamProvider,
  mediaType: 'live' | 'movie' | 'episode',
  id: string | number,
  extension: string,
) {
  const url = new URL(provider.server)
  url.search = ''
  url.hash = ''
  const pathType = mediaType === 'movie' ? 'movie' : mediaType === 'episode' ? 'series' : 'live'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${pathType}/${encodeURIComponent(provider.username)}/${encodeURIComponent(provider.password)}/${encodeURIComponent(String(id))}.${extension}`
  return url.toString()
}

function getNativeXtreamDetails(item: Record<string, unknown>) {
  const text = (...values: unknown[]) => values.find(
    (value): value is string => typeof value === 'string' && Boolean(value.trim()),
  )?.trim()
  const releaseDate = text(item.releaseDate, item.release_date)
  const durationSeconds = Number(item.duration_secs)
  const duration = text(item.duration) ?? (
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? `${Math.floor(durationSeconds / 3600)} h ${Math.round((durationSeconds % 3600) / 60)} min`
      : undefined
  )
  const year = text(item.year) ?? releaseDate?.match(/\b(?:19|20)\d{2}\b/)?.[0]
  return {
    ...(year ? { year } : {}),
    ...(releaseDate ? { releaseDate } : {}),
    ...(duration ? { duration } : {}),
    ...(text(item.genre) ? { genre: text(item.genre) } : {}),
    ...(text(item.director) ? { director: text(item.director) } : {}),
    ...(text(item.cast) ? { cast: text(item.cast) } : {}),
    ...(text(item.rating) ? { rating: text(item.rating) } : {}),
  }
}

function getNativeXtreamVodId(channel: Channel) {
  try {
    const file = new URL(channel.stream).pathname.split('/').filter(Boolean).pop() ?? ''
    const id = file.replace(/\.[a-zA-Z0-9]{1,5}$/, '')
    if (id) return id
  } catch {
    // ignore, on retombe sur l'identifiant interne
  }
  return channel.id.replace(/^movie-/, '')
}

function getNativeXtreamVodInfo(payload: unknown) {
  const data = isRecord(payload) ? payload : {}
  const info = isRecord(data.info) ? data.info : isRecord(data.movie_data) ? data.movie_data : data
  const text = (...values: unknown[]) => values.find(
    (value): value is string => typeof value === 'string' && Boolean(value.trim()),
  )?.trim()
  const releaseDate = text(info.releasedate, info.release_date, info.releaseDate)
  const durationSeconds = Number(info.duration_secs)
  const duration = text(info.duration) ?? (
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? `${Math.floor(durationSeconds / 3600)} h ${String(Math.round((durationSeconds % 3600) / 60)).padStart(2, '0')} min`
      : ''
  )
  const year = text(info.year) ?? releaseDate?.match(/\b(?:19|20)\d{2}\b/)?.[0]
  return {
    plot: text(info.plot, info.description) ?? '',
    details: {
      ...(year ? { year } : {}),
      ...(releaseDate ? { releaseDate } : {}),
      ...(duration ? { duration } : {}),
      ...(text(info.genre) ? { genre: text(info.genre) } : {}),
      ...(text(info.director) ? { director: text(info.director) } : {}),
      ...(text(info.cast, info.actors) ? { cast: text(info.cast, info.actors) } : {}),
      ...(text(info.rating) ? { rating: text(info.rating) } : {}),
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function getXtreamCategoryNames(value: unknown) {
  const names = new Map<string, string>()
  if (!Array.isArray(value)) return names
  for (const category of value) {
    if (
      isRecord(category) &&
      (typeof category.category_id === 'string' || typeof category.category_id === 'number') &&
      typeof category.category_name === 'string'
    ) {
      names.set(String(category.category_id), category.category_name)
    }
  }
  return names
}

async function fetchNativeXtreamCatalog(provider: XtreamProvider, includeLive = true): Promise<Channel[]> {
  const actions = includeLive
    ? [
        'get_live_streams',
        'get_live_categories',
        'get_vod_streams',
        'get_vod_categories',
        'get_series',
        'get_series_categories',
      ]
    : ['get_vod_streams', 'get_vod_categories', 'get_series', 'get_series_categories']
  const payloads = await Promise.all(actions.map((action) =>
    fetchNativeProviderText(createXtreamApiUrl(provider, action)),
  ))
  const parsed = payloads.map((payload) => {
    try {
      return JSON.parse(payload) as unknown
    } catch {
      throw new Error('Réponse Xtream Codes invalide.')
    }
  })
  const [liveStreams, liveCategories, vodStreams, vodCategories, seriesList, seriesCategories] = includeLive
    ? parsed
    : [[], [], ...parsed]
  if (
    !Array.isArray(vodStreams) ||
    !Array.isArray(seriesList) ||
    (includeLive && !Array.isArray(liveStreams))
  ) {
    throw new Error('Identifiants Xtream Codes refusés ou réponse inattendue.')
  }

  const liveCategoryNames = getXtreamCategoryNames(liveCategories)
  const vodCategoryNames = getXtreamCategoryNames(vodCategories)
  const seriesCategoryNames = getXtreamCategoryNames(seriesCategories)
  const toChannels = (
    value: unknown[],
    kind: 'live' | 'movie' | 'series',
    categoryNames: Map<string, string>,
  ): Channel[] => value.flatMap((item) => {
    if (
      !isRecord(item) ||
      (typeof item.stream_id !== 'string' && typeof item.stream_id !== 'number' &&
        typeof item.series_id !== 'string' && typeof item.series_id !== 'number') ||
      typeof item.name !== 'string' ||
      !item.name.trim()
    ) return []

    const id = kind === 'series' ? item.series_id : item.stream_id
    if (typeof id !== 'string' && typeof id !== 'number') return []
    const extension = typeof item.container_extension === 'string' &&
      /^[a-zA-Z0-9]{2,5}$/.test(item.container_extension)
      ? item.container_extension.toLowerCase()
      : kind === 'live' ? 'ts' : 'mp4'
    const group = typeof item.category_name === 'string'
      ? item.category_name
      : categoryNames.get(String(item.category_id)) ??
        (kind === 'movie' ? 'Films' : kind === 'series' ? 'Séries' : 'Live')
    const channelKind = kind === 'series' ? 'series' : kind
    return [{
      id: kind === 'series' ? `series-${String(id)}` : `${kind === 'movie' ? 'movie' : 'xtream'}-${String(id)}`,
      name: item.name.trim(),
      group,
      logo: typeof item.stream_icon === 'string'
        ? item.stream_icon
        : typeof item.cover === 'string'
          ? item.cover
          : '',
      stream: kind === 'series' ? '' : buildXtreamStreamUrl(provider, kind, id, extension),
      epg: typeof item.plot === 'string' ? item.plot : kind === 'movie' ? 'Film' : kind === 'series' ? 'Série' : 'Xtream Codes live stream',
      quality: 'HD',
      isLive: kind === 'live',
      isFavorite: false,
      mediaType: channelKind,
      ...(kind === 'series' ? { seriesId: String(id) } : {}),
      ...(kind !== 'live' ? { details: getNativeXtreamDetails(item) } : {}),
    }]
  })

  const live = includeLive ? toChannels(liveStreams as unknown[], 'live', liveCategoryNames) : []
  const movies = toChannels(vodStreams, 'movie', vodCategoryNames)
  const series = toChannels(seriesList, 'series', seriesCategoryNames)
  if (includeLive && live.length + movies.length + series.length === 0) {
    throw new Error('Aucune chaîne, film ou série disponible pour ce compte.')
  }
  return [...live, ...movies, ...series]
}

async function fetchNativeXtreamEpisodes(provider: XtreamProvider, seriesId: string): Promise<Channel[]> {
  let seriesInfo: unknown
  try {
    seriesInfo = JSON.parse(await fetchNativeProviderText(
      createXtreamApiUrl(provider, 'get_series_info', { series_id: seriesId }),
    )) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Réponse Xtream Codes invalide pour les épisodes.')
    throw error
  }
  if (!isRecord(seriesInfo) || !isRecord(seriesInfo.episodes)) {
    throw new Error('Aucun épisode disponible pour cette série.')
  }
  return Object.entries(seriesInfo.episodes).flatMap(([season, items]) => {
    if (!Array.isArray(items)) return []
    return items.flatMap((item) => {
      if (!isRecord(item) || (typeof item.id !== 'string' && typeof item.id !== 'number')) return []
      const extension = typeof item.container_extension === 'string' &&
        /^[a-zA-Z0-9]{2,5}$/.test(item.container_extension)
        ? item.container_extension.toLowerCase()
        : 'mp4'
      const episodeNumber = Number(item.episode_num)
      const info = isRecord(item.info) ? item.info : {}
      return [{
        id: `episode-${String(item.id)}`,
        name: typeof item.title === 'string' && item.title.trim()
          ? item.title.trim()
          : `Épisode ${episodeNumber || ''}`.trim(),
        group: `Saison ${season}`,
        logo: typeof info.movie_image === 'string' ? info.movie_image : '',
        stream: buildXtreamStreamUrl(provider, 'episode', item.id, extension),
        epg: typeof info.plot === 'string' ? info.plot : 'Épisode de série',
        quality: 'HD',
        isLive: false,
        isFavorite: false,
        mediaType: 'episode' as const,
      }]
    })
  })
}

function applyNativePlaylistCustomizations(channels: Channel[], playlist: Playlist) {
  const customizations = getNativePlaylistCustomizations(playlist)
  return channels.map((channel) => ({
    ...channel,
    name: customizations.channelNames[channel.stream] ?? channel.name,
    group: customizations.groupNames[channel.group] ?? channel.group,
    isFavorite: Boolean(
      customizations.favoriteChannels.includes(channel.stream) ||
      customizations.favoriteGroups.includes(channel.group),
    ),
  }))
}

function getNativePlaylistCustomizations(playlist: Playlist): NonNullable<Playlist['customizations']> {
  return {
    channelNames: playlist.customizations?.channelNames ?? {},
    groupNames: playlist.customizations?.groupNames ?? {},
    hiddenGroups: playlist.customizations?.hiddenGroups ?? [],
    favoriteGroups: playlist.customizations?.favoriteGroups ?? [],
    hiddenChannels: playlist.customizations?.hiddenChannels ?? [],
    favoriteChannels: playlist.customizations?.favoriteChannels ?? [],
  }
}

function createNativePlaylist(name: string, channels: Channel[], sourceType: Playlist['sourceType']): Playlist {
  const trimmedName = name.trim()
  if (!trimmedName || trimmedName.length > 120) {
    throw new Error('Le nom de la playlist doit contenir entre 1 et 120 caractères.')
  }
  if (channels.length === 0) throw new Error('La playlist ne contient aucun élément lisible.')
  return {
    id: crypto.randomUUID().replace(/-/g, ''),
    name: trimmedName,
    createdAt: new Date().toISOString(),
    channels,
    sourceType,
  }
}

async function nativeApiFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, window.location.origin)
  const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const method = (init?.method ?? 'GET').toUpperCase()
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
  const playlistId = path[2]
  const errorResponse = (message: string, status: number) => nativeJsonResponse({ error: message }, status)

  try {
    if (path.join('/') === 'api/stream-info' && method === 'GET') {
      const streamUrl = url.searchParams.get('url') ?? ''
      if (!streamUrl || streamUrl.length > 8192) {
        return errorResponse('URL du flux invalide.', 400)
      }
      if (!Capacitor.isNativePlatform()) {
        return errorResponse('Vérification de flux indisponible hors application native.', 400)
      }
      try {
        const response = await CapacitorHttp.request({
          url: streamUrl,
          method: 'HEAD',
          headers: { Accept: '*/*', 'User-Agent': PROVIDER_USER_AGENT },
          connectTimeout: 12_000,
          readTimeout: 12_000,
        })
        const responseHeaders = (response.headers ?? {}) as Record<string, string>
        const contentType =
          responseHeaders['Content-Type'] ?? responseHeaders['content-type'] ?? ''
        const streamPath = (() => {
          try {
            return new URL(streamUrl).pathname.toLowerCase()
          } catch {
            return streamUrl.toLowerCase()
          }
        })()
        return nativeJsonResponse({
          status: response.status,
          contentType,
          isTransportStream: /video\/mp2t/i.test(contentType) || /\.(ts|m2ts)$/.test(streamPath),
        })
      } catch (error) {
        return errorResponse(getNativeErrorMessage(error), 502)
      }
    }
    if (path.join('/') === 'api/playlists' && method === 'GET') {
      const playlists = await getNativePlaylists<Playlist>()
      return nativeJsonResponse({ playlists: playlists.map(nativePublicPlaylist) })
    }
    if (path.join('/') === 'api/playlists' && method === 'POST') {
      const channels = sanitizeNativeChannels(body.channels)
      const playlist = createNativePlaylist(String(body.name ?? ''), channels, 'file')
      await saveNativePlaylist(playlist)
      return nativeJsonResponse({ playlist: nativePublicPlaylist(playlist) }, 201)
    }
    if (path.join('/') === 'api/playlists/import-url' && method === 'POST') {
      const m3uUrl = String(body.url ?? '').trim()
      const channels = parseM3u(await fetchNativeProviderText(m3uUrl))
      if (channels.length === 0) throw new Error('Aucune chaîne valide trouvée dans cette playlist M3U.')
      const playlist = { ...createNativePlaylist(String(body.name ?? ''), channels, 'm3u'), m3uUrl }
      await saveNativePlaylist(playlist)
      return nativeJsonResponse({ playlist: nativePublicPlaylist(playlist) }, 201)
    }
    if (path.join('/') === 'api/playlists/import-xtream' && method === 'POST') {
      const provider = {
        server: String(body.server ?? '').trim().replace(/\/+$/, ''),
        username: String(body.username ?? '').trim(),
        password: String(body.password ?? ''),
      }
      if (!provider.server || !provider.username || !provider.password) {
        throw new Error('Saisissez l’adresse du serveur, l’identifiant et le mot de passe Xtream.')
      }
      const channels = await fetchNativeXtreamCatalog(provider)
      const playlist = { ...createNativePlaylist(String(body.name ?? ''), channels, 'xtream'), provider }
      await saveNativePlaylist(playlist)
      return nativeJsonResponse({ playlist: nativePublicPlaylist(playlist) }, 201)
    }
    if (path[0] !== 'api' || path[1] !== 'playlists' || !playlistId) {
      return errorResponse('Route API introuvable.', 404)
    }

    if (path[3] === 'series' && path[5] === 'episodes' && method === 'POST') {
      const playlist = await getNativePlaylist<Playlist>(playlistId)
      if (!playlist?.provider) return errorResponse('Les informations Xtream de cette playlist sont introuvables.', 404)
      const seriesId = path[4]
      if (!seriesId || !playlist.channels.some((channel) => channel.mediaType === 'series' && channel.seriesId === seriesId)) {
        return errorResponse('Série introuvable dans cette playlist.', 404)
      }
      return nativeJsonResponse({ episodes: await fetchNativeXtreamEpisodes(playlist.provider, seriesId) })
    }

    if (path[3] === 'series' && path[5] === 'info' && method === 'POST') {
      const playlist = await getNativePlaylist<Playlist>(playlistId)
      if (!playlist?.provider) return errorResponse('Les informations Xtream de cette playlist sont introuvables.', 404)
      const seriesId = path[4]
      if (!seriesId || !playlist.channels.some((channel) => channel.mediaType === 'series' && channel.seriesId === seriesId)) {
        return errorResponse('Série introuvable dans cette playlist.', 404)
      }
      const payload = JSON.parse(await fetchNativeProviderText(
        createXtreamApiUrl(playlist.provider, 'get_series_info', { series_id: seriesId }),
      )) as unknown
      return nativeJsonResponse(getNativeXtreamVodInfo(payload))
    }

    if (path[3] === 'movies' && path[5] === 'info' && method === 'POST') {
      const playlist = await getNativePlaylist<Playlist>(playlistId)
      if (!playlist?.provider) return errorResponse('Les informations Xtream de cette playlist sont introuvables.', 404)
      const movieId = path[4]
      const movie = playlist.channels.find((channel) => channel.mediaType === 'movie' && channel.id === movieId)
      if (!movie) return errorResponse('Film introuvable dans cette playlist.', 404)
      const vodId = getNativeXtreamVodId(movie)
      if (!vodId) return errorResponse('Identifiant du film introuvable.', 404)
      const payload = JSON.parse(await fetchNativeProviderText(
        createXtreamApiUrl(playlist.provider, 'get_vod_info', { vod_id: vodId }),
      )) as unknown
      return nativeJsonResponse(getNativeXtreamVodInfo(payload))
    }

    if (path[3] === 'source-details' && method === 'GET') {
      const playlist = await getNativePlaylist<Playlist>(playlistId)
      if (!playlist) return errorResponse('Playlist introuvable.', 404)
      return nativeJsonResponse({
        sourceType: playlist.sourceType ?? (playlist.provider ? 'xtream' : playlist.m3uUrl ? 'm3u' : 'file'),
        url: playlist.m3uUrl ?? '',
        server: playlist.provider?.server ?? '',
        username: playlist.provider?.username ?? '',
        password: playlist.provider?.password ?? '',
      })
    }

    if (path[3] === 'epg' && method === 'GET') {
      const playlist = await getNativePlaylist<Playlist>(playlistId)
      if (!playlist) return errorResponse('Playlist introuvable.', 404)
      if (!playlist.provider) return nativeJsonResponse({ epg: null })
      try {
        const payload = JSON.parse(await fetchNativeProviderText(
          createXtreamApiUrl(playlist.provider, 'get_simple_data_table'),
        )) as unknown
        const listings = isRecord(payload) && Array.isArray(payload.epg_listings) ? payload.epg_listings : []
        const epgMap: Record<string, EpgProgram[]> = {}
        for (const listing of listings) {
          if (!isRecord(listing)) continue
          const channelId = listing.epg_channel_id ?? listing.channel_id
          if (typeof channelId !== 'string' && typeof channelId !== 'number') continue
          const start = typeof listing.start === 'string' ? new Date(listing.start.replace(' ', 'T')).getTime() / 1000 : NaN
          const stop = typeof listing.stop === 'string' ? new Date(listing.stop.replace(' ', 'T')).getTime() / 1000 : NaN
          if (!Number.isFinite(start) || !Number.isFinite(stop)) continue
          const key = String(channelId)
          const programs = epgMap[key] ?? (epgMap[key] = [])
          programs.push({
            id: `epg-${key}-${start}-${Math.random().toString(36).slice(2, 8)}`,
            title: typeof listing.title === 'string' ? listing.title : 'Sans titre',
            description: typeof listing.description === 'string' ? listing.description : '',
            start,
            stop,
            channelId: key,
          })
        }
        return nativeJsonResponse({ epg: Object.keys(epgMap).length > 0 ? epgMap : null })
      } catch (error) {
        console.warn('[EPG] get_simple_data_table a échoué :', error)
        return nativeJsonResponse({ epg: null })
      }
    }

    if (path[3] === 'status' && method === 'PATCH') {
      const playlist = await updateNativePlaylist<Playlist>(playlistId, (current) => ({
        ...current,
        suspended: body.suspended === true,
      }))
      return playlist
        ? nativeJsonResponse({ playlist: nativePublicPlaylist(playlist) })
        : errorResponse('Playlist introuvable.', 404)
    }

    if (path[3] === 'customizations' && method === 'PATCH') {
      const playlist = await getNativePlaylist<Playlist>(playlistId)
      if (!playlist) return errorResponse('Playlist introuvable.', 404)
      const action = String(body.action ?? '')
      const group = String(body.group ?? '').trim()
      const name = String(body.name ?? '').trim()
      const channel = playlist.channels.find((item) => item.id === body.channelId)
      const previous = getNativePlaylistCustomizations(playlist)
      const customizations = {
        channelNames: { ...previous.channelNames },
        groupNames: { ...previous.groupNames },
        hiddenGroups: [...previous.hiddenGroups],
        favoriteGroups: [...previous.favoriteGroups],
        hiddenChannels: [...previous.hiddenChannels],
        favoriteChannels: [...previous.favoriteChannels],
      }
      if (action === 'rename-group' && group && name) {
        customizations.groupNames[group] = name
      } else if (['hide-group', 'show-group', 'favorite-group', 'unfavorite-group'].includes(action) && group) {
        const favorites = action.endsWith('favorite-group')
        const values = new Set(favorites ? customizations.favoriteGroups : customizations.hiddenGroups)
        if (action.startsWith('hide-') || action === 'favorite-group') values.add(group)
        else values.delete(group)
        if (favorites) customizations.favoriteGroups = [...values]
        else customizations.hiddenGroups = [...values]
      } else if (channel && ['rename-channel', 'hide-channel', 'show-channel', 'favorite-channel', 'unfavorite-channel'].includes(action)) {
        if (action === 'rename-channel' && name) {
          customizations.channelNames[channel.stream] = name
        } else {
          const favorites = action.endsWith('favorite-channel')
          const values = new Set(favorites ? customizations.favoriteChannels : customizations.hiddenChannels)
          if (action.startsWith('hide-') || action === 'favorite-channel') values.add(channel.stream)
          else values.delete(channel.stream)
          if (favorites) customizations.favoriteChannels = [...values]
          else customizations.hiddenChannels = [...values]
        }
      } else {
        return errorResponse('Modification de playlist invalide.', 400)
      }
      const updated = {
        ...playlist,
        customizations,
        channels: applyNativePlaylistCustomizations(playlist.channels, { ...playlist, customizations }),
      }
      await saveNativePlaylist(updated)
      return nativeJsonResponse({ playlist: nativePublicPlaylist(updated) })
    }

    if (path.length === 3 && method === 'DELETE') {
      const playlist = await getNativePlaylist<Playlist>(playlistId)
      if (!playlist) return errorResponse('Playlist introuvable.', 404)
      await deleteNativePlaylist(playlistId)
      return nativeJsonResponse({ deleted: true })
    }

    if (path[3] === 'refresh-xtream' && method === 'POST') {
      const playlist = await getNativePlaylist<Playlist>(playlistId)
      if (!playlist) return errorResponse('Playlist introuvable.', 404)
      let channels: Channel[]
      if (playlist.sourceType === 'm3u' && playlist.m3uUrl) {
        channels = parseM3u(await fetchNativeProviderText(playlist.m3uUrl))
      } else if (playlist.provider) {
        const catalog = await fetchNativeXtreamCatalog(playlist.provider, false)
        const liveChannels = playlist.channels.filter((channel) => getChannelMediaType(channel) === 'live')
        channels = [...liveChannels, ...catalog]
      } else {
        return errorResponse('Cette playlist ne possède pas de source actualisable.', 400)
      }
      if (channels.length === 0) throw new Error('Aucune chaîne valide trouvée dans cette source.')
      const customizations = {
        ...getNativePlaylistCustomizations(playlist),
        hiddenGroups: [],
      }
      const updated = {
        ...playlist,
        channels: applyNativePlaylistCustomizations(channels, { ...playlist, customizations }),
        customizations,
      }
      await saveNativePlaylist(updated)
      return nativeJsonResponse({ playlist: nativePublicPlaylist(updated) })
    }

    if (path.length === 3 && method === 'PATCH') {
      const playlist = await getNativePlaylist<Playlist>(playlistId)
      if (!playlist) return errorResponse('Playlist introuvable.', 404)
      const name = String(body.name ?? '').trim()
      if (!name || name.length > 120) return errorResponse('Le nom de la playlist doit contenir entre 1 et 120 caractères.', 400)
      let updated: Playlist = { ...playlist, name }
      if (Array.isArray(body.channels)) {
        updated = {
          ...updated,
          channels: sanitizeNativeChannels(body.channels),
          sourceType: 'file',
          m3uUrl: undefined,
          provider: undefined,
        }
      } else if (typeof body.url === 'string' && body.url.trim()) {
        const m3uUrl = body.url.trim()
        const channels = parseM3u(await fetchNativeProviderText(m3uUrl))
        if (!channels.length) throw new Error('Aucune chaîne valide trouvée dans cette playlist M3U.')
        updated = { ...updated, channels, sourceType: 'm3u', m3uUrl, provider: undefined }
      } else if (typeof body.server === 'string' || typeof body.username === 'string' || typeof body.password === 'string') {
        const provider = {
          server: String(body.server ?? playlist.provider?.server ?? '').trim().replace(/\/+$/, ''),
          username: String(body.username ?? playlist.provider?.username ?? '').trim(),
          password: String(body.password ?? playlist.provider?.password ?? ''),
        }
        if (!provider.server || !provider.username || !provider.password) {
          return errorResponse('Saisissez l’adresse, l’identifiant et le mot de passe Xtream.', 400)
        }
        updated = {
          ...updated,
          channels: await fetchNativeXtreamCatalog(provider),
          sourceType: 'xtream',
          provider,
          m3uUrl: undefined,
        }
      }
      updated.channels = applyNativePlaylistCustomizations(updated.channels, updated)
      await saveNativePlaylist(updated)
      return nativeJsonResponse({ playlist: nativePublicPlaylist(updated) })
    }

    return errorResponse('Route API introuvable.', 404)
  } catch (error) {
    return nativeJsonResponse({ error: getNativeErrorMessage(error) }, 502)
  }
}

function sanitizeNativeChannels(value: unknown): Channel[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('La playlist doit contenir au moins une chaîne.')
  }
  return value.map((item) => {
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim() || typeof item.stream !== 'string') {
      throw new Error('Une chaîne de la playlist est invalide.')
    }
    let streamUrl: URL
    try {
      streamUrl = new URL(item.stream)
    } catch {
      throw new Error('Une adresse de flux de la playlist est invalide.')
    }
    if (!['http:', 'https:'].includes(streamUrl.protocol)) {
      throw new Error('Les flux doivent utiliser HTTP ou HTTPS.')
    }
    const mediaType =
      item.mediaType === 'movie' || item.mediaType === 'series' || item.mediaType === 'episode'
        ? item.mediaType
        : 'live'
    return {
      id: typeof item.id === 'string' ? item.id.slice(0, 200) : crypto.randomUUID(),
      name: item.name.trim().slice(0, 200),
      group: typeof item.group === 'string' ? item.group.trim().slice(0, 120) || 'General' : 'General',
      logo: typeof item.logo === 'string' ? item.logo.slice(0, 500) : '',
      stream: streamUrl.toString(),
      epg: typeof item.epg === 'string' ? item.epg.slice(0, 300) : '',
      quality: typeof item.quality === 'string' ? item.quality.slice(0, 20) : 'HD',
      isLive: item.isLive !== false,
      isFavorite: false,
      mediaType,
      ...(typeof item.seriesId === 'string' ? { seriesId: item.seriesId.slice(0, 200) } : {}),
      ...(isRecord(item.details) ? { details: item.details as Channel['details'] } : {}),
    }
  })
}

/* ---------- Horloge isolée ---------- */
// Rendue à part : elle se met à jour toute seule chaque seconde sans relancer
// le rendu de l'application entière (allège la navigation sur les boîtiers TV).
function LiveClock({ className }: { className?: string }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <time
      className={className}
      dateTime={now.toISOString()}
      aria-label="Heure actuelle"
    >
      {now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
    </time>
  )
}

function VideoPlayer({
  channel,
  resumePosition = 0,
  autoPlay = false,
  compact = false,
  muted = false,
  onPlaybackProgress,
  onPlaybackStart,
  onToggleTheater,
  onTheaterModeChange,
  seriesName,
  epgProgram,
  nextEpgProgram,
}: {
  channel: Channel
  resumePosition?: number
  autoPlay?: boolean
  compact?: boolean
  muted?: boolean
  onPlaybackProgress?: (position: number) => void
  onPlaybackStart?: (channel: Channel) => void
  onToggleTheater?: () => void
  onTheaterModeChange?: (enabled: boolean) => void
  seriesName?: string
  epgProgram?: EpgProgram | null
  nextEpgProgram?: EpgProgram | null
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoSurfaceRef = useRef<HTMLDivElement | null>(null)
  const remoteFullscreenPressRef = useRef(0)
  const mpegtsPlayerRef = useRef<Mpegts.Player | null>(null)
  const hlsPlayerRef = useRef<HlsPlayer | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const lastProgressSentRef = useRef(0)
  // Surveillance anti-blocage : dernière fois où l'image a réellement progressé.
  const lastMediaProgressAtRef = useRef(Date.now())
  const lastReconnectAtRef = useRef(0)
  const resumePositionRef = useRef(resumePosition)
  const [playbackMessage, setPlaybackMessage] = useState('Chargement du flux vidéo…')
  const [controlMessage, setControlMessage] = useState('')
  const [showInformation, setShowInformation] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [hasSubtitles, setHasSubtitles] = useState(false)
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(false)
   const [, setIsPlaying] = useState(false)
  // Lecture auto démarrée en muet car le navigateur a refusé le son sans geste.
  const [soundBlocked, setSoundBlocked] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [isVideoFullscreen, setIsVideoFullscreen] = useState(false)
  const [showFullscreenClock, setShowFullscreenClock] = useState(false)
  const [playbackFailed, setPlaybackFailed] = useState(false)
  const [playbackRetryCount, setPlaybackRetryCount] = useState(0)
  useEffect(() => {
    resumePositionRef.current = resumePosition
  }, [resumePosition])
  const isLiveChannel = getChannelMediaType(channel) === 'live'
  const mediaType = getChannelMediaType(channel)
  // Sur Android, les flux passent par le proxy natif « /__stream » (équivalent de
  // /api/stream côté PC) : lecture continue, Range et réécriture des manifestes HLS.
  const useNativeStreamProxy = Capacitor.isNativePlatform() && !getApiBaseUrl()
  const informationLabel = channel.mediaType === 'episode'
    ? 'Épisode'
    : mediaType === 'live'
      ? 'Chaîne live'
      : mediaType === 'movie'
        ? 'Film'
        : 'Série'
  const channelDescription = channel.epg.trim()
  const hasChannelDescription = Boolean(
    channelDescription &&
      !['film', 'série', 'episode de série', 'imported playlist channel', 'xtream codes live stream']
        .includes(channelDescription.toLocaleLowerCase()),
  )
  const isEpisode = channel.mediaType === 'episode'
  const shouldAutoPlay = isLiveChannel || autoPlay
  const streamUrl = useMemo(() => {
    if (useNativeStreamProxy) return createNativeStreamUrl(channel.stream)
    const url = new URL(
      apiUrl(`/api/stream?url=${encodeURIComponent(channel.stream)}`),
      window.location.origin,
    )
    const streamTicket = localStorage.getItem(STREAM_TICKET_KEY)
    if (streamTicket) url.searchParams.set('ticket', streamTicket)
    return url.toString()
  }, [channel.stream, useNativeStreamProxy])

  useEffect(() => {
    let hideClockTimer: number | undefined
    const handleFullscreenChange = () => {
      const fullscreenElement = document.fullscreenElement
      const video = videoRef.current
      const surface = videoSurfaceRef.current
      const isFullscreen = Boolean(
        fullscreenElement &&
          ((video && (fullscreenElement === video || video.contains(fullscreenElement))) ||
            (surface && (fullscreenElement === surface || surface.contains(fullscreenElement)))),
      )
      setIsVideoFullscreen(isFullscreen)
      setShowFullscreenClock(isFullscreen)
      onTheaterModeChange?.(isFullscreen)
      if (hideClockTimer !== undefined) window.clearTimeout(hideClockTimer)
      if (isFullscreen) {
        hideClockTimer = window.setTimeout(() => setShowFullscreenClock(false), 5000)
      }
    }
    const video = videoRef.current
    const handleNativeFullscreenStart = () => onTheaterModeChange?.(true)
    const handleNativeFullscreenEnd = () => onTheaterModeChange?.(false)
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    video?.addEventListener('webkitbeginfullscreen', handleNativeFullscreenStart)
    video?.addEventListener('webkitendfullscreen', handleNativeFullscreenEnd)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      video?.removeEventListener('webkitbeginfullscreen', handleNativeFullscreenStart)
      video?.removeEventListener('webkitendfullscreen', handleNativeFullscreenEnd)
      if (hideClockTimer !== undefined) window.clearTimeout(hideClockTimer)
    }
  }, [onTheaterModeChange])

  useEffect(() => {
    if (!channel.stream) return

    const video = videoRef.current
    if (!video) return

    let cancelled = false
    let hlsPlayer: HlsPlayer | null = null
    let mpegtsPlayer: Mpegts.Player | null = null
    let nativeFallbackAttempted = false
    let mpegtsAutoRetries = 0
    const startSelectedMedia = () => {
      // Le son est activé dès le démarrage (chaînes, films et séries). Le mode muet
      // du multi-écran reste respecté via la prop `muted`.
      if (!muted) video.muted = false
      void video.play().then(() => {
        setPlaybackFailed(false)
        setPlaybackMessage('')
        setSoundBlocked(false)
      }).catch((error: unknown) => {
        if (cancelled) return
        // Un nouveau chargement qui interrompt la lecture n'est pas un blocage du son :
        // ne pas couper le son dans ce cas.
        if (error instanceof DOMException && error.name === 'AbortError') return
        // Autoplay avec son refusé par le navigateur : image immédiate en muet,
        // l'utilisateur réactive le son d'un geste via le bouton dédié.
        video.muted = true
        setSoundBlocked(true)
        void video.play().then(() => setPlaybackMessage('')).catch(() => {
          if (!cancelled) setPlaybackMessage('Flux chargé — appuyez sur « Lire avec son ».')
        })
      })
    }
    const handleMediaReady = () => {
      const resumePosition = resumePositionRef.current
      if (resumePosition > 0 && Number.isFinite(video.duration) && resumePosition < video.duration) {
        video.currentTime = resumePosition
      }
      if (shouldAutoPlay) startSelectedMedia()
    }
    video.addEventListener('loadedmetadata', handleMediaReady, { once: true })
    const streamPath = (() => {
      try {
        return new URL(channel.stream).pathname.toLowerCase()
      } catch {
        return channel.stream.toLowerCase()
      }
    })()
    const streamFormatIsKnown =
      /\.(ts|m2ts|m3u8|m3u|mp4|m4v|webm|mp3|aac|mpg|mpeg)$/.test(streamPath)
    const initializePlayer = (contentType: string, detectedTransportStream = false) => {
      const isTransportStream =
        detectedTransportStream || /\.(ts|m2ts)$/.test(streamPath) || /video\/mp2t/i.test(contentType)
      const isHls =
        /\.m3u8?$/.test(streamPath) || /mpegurl|vnd\.apple\.mpegurl/i.test(contentType)

      if (isTransportStream) {
        void import('mpegts.js').then(({ default: mpegts }) => {
          if (cancelled) return
          if (!mpegts.isSupported()) {
            setPlaybackFailed(true)
            setPlaybackMessage('Ce navigateur ne prend pas en charge ce flux MPEG-TS.')
            return
          }

          const player = mpegts.createPlayer(
            { type: 'mpegts', isLive: isLiveChannel, url: streamUrl },
            {
              // Sur mobile, le Web Worker n'est pas couvert par CapacitorHttp : ses requêtes
              // cross-origin étaient bloquées (CORS), donc les flux .ts ne démarraient pas.
              // Sans worker, mpegts.js émet ses requêtes sur le thread principal (intercepté).
              enableWorker: !Capacitor.isNativePlatform(),
              enableStashBuffer: true,
              // Tampon d'entrée plus large : absorbe les micro-coupures du réseau.
              stashInitialSize: 1024 * 1024,
              // Nettoyage automatique du SourceBuffer : sans lui, la mémoire grossissait
              // pendant des heures et la lecture finissait par se figer sur les TV box.
              autoCleanupSourceBuffer: true,
              autoCleanupMaxBackwardDuration: 90,
              autoCleanupMinBackwardDuration: 45,
              reuseRedirectedURL: true,
              fixAudioTimestampGap: true,
            },
          )
          const onMediaInfo = () => {
            setPlaybackFailed(false)
            setPlaybackMessage('')
          }
          const onError = (_type: string, detail: string, info?: { code?: number }) => {
            if (cancelled) return
            if (
              !nativeFallbackAttempted &&
              /MediaMSEError/i.test(detail) &&
              video.canPlayType('video/mp2t') !== ''
            ) {
              nativeFallbackAttempted = true
              player.destroy()
              mpegtsPlayerRef.current = null
              mpegtsPlayer = null
              video.addEventListener('loadedmetadata', handleMediaReady, { once: true })
              video.src = streamUrl
              video.load()
              setPlaybackMessage('Essai d’un autre mode de lecture…')
              return
            }
            setPlaybackFailed(true)
            const status = info?.code && info.code > 0 ? ` (HTTP ${info.code})` : ''
            // Coupure réseau passagère : on relance automatiquement le décodeur
            // avant d'afficher l'erreur définitive à l'utilisateur.
            if (mpegtsAutoRetries < 2 && detail !== 'HttpStatusCodeInvalid') {
              mpegtsAutoRetries += 1
              player.destroy()
              mpegtsPlayerRef.current = null
              mpegtsPlayer = null
              setPlaybackFailed(false)
              setPlaybackMessage('Connexion au flux interrompue — nouvelle tentative…')
              window.setTimeout(() => setPlaybackRetryCount((count) => count + 1), 1500)
              return
            }
            setPlaybackMessage(detail === 'HttpStatusCodeInvalid'
              ? `Le fournisseur refuse ce flux${status}. Vérifiez que le lien est toujours valide ou réessayez.`
              : `Erreur de lecture du programme : ${detail || 'format ou flux refusé'}.`)
          }

          mpegtsPlayerRef.current = player
          mpegtsPlayer = player
          player.on(mpegts.Events.MEDIA_INFO, onMediaInfo)
          player.on(mpegts.Events.ERROR, onError)
          player.attachMediaElement(video)
          player.load()
          if (shouldAutoPlay) {
            void Promise.resolve(player.play()).catch(() => {
              if (!cancelled) setPlaybackMessage('Flux chargé — appuyez sur « Lire avec son ».')
            })
          } else {
            setPlaybackMessage('Flux chargé — appuyez sur « Lire avec son ».')
          }
        }).catch((error: unknown) => {
          if (!cancelled) {
            setPlaybackFailed(true)
            setPlaybackMessage(error instanceof Error ? error.message : 'Impossible de charger le décodeur MPEG-TS.')
          }
        })
        return
      }

      if (isHls) {
        void import('hls.js').then(({ default: Hls }) => {
          if (cancelled) return
          if (!Hls.isSupported()) {
            if (!video.canPlayType('application/vnd.apple.mpegurl')) {
              setPlaybackFailed(true)
              setPlaybackMessage('Ce navigateur ne prend pas en charge les flux HLS.')
              return
            }
            video.src = streamUrl
            video.load()
            if (shouldAutoPlay) startSelectedMedia()
            else setPlaybackMessage('Flux chargé — appuyez sur « Lire avec son ».')
            return
          }

          const player = new Hls({
            // Décodage dans un thread dédié ; le réseau reste sur le thread principal,
            // déjà couvert par le proxy natif /__stream.
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 60,
            maxBufferLength: 60,
            maxMaxBufferLength: 180,
            manifestLoadingTimeOut: 20_000,
            levelLoadingTimeOut: 20_000,
            fragLoadingTimeOut: 45_000,
            manifestLoadingMaxRetry: 4,
            levelLoadingMaxRetry: 4,
            fragLoadingMaxRetry: 6,
            ...(isLiveChannel ? { liveDurationInfinity: false, liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 6, liveBackBufferLength: 30 } : {}),
          })
          hlsPlayer = player
          hlsPlayerRef.current = player
          let hlsRecoveryAttempts = 0
          const onManifestParsed = () => {
            if (shouldAutoPlay) {
              startSelectedMedia()
            } else {
              setPlaybackMessage('Flux chargé — appuyez sur « Lire avec son ».')
            }
          }
          const onHlsError = (_event: string, data: { fatal?: boolean; type?: string; details?: string }) => {
            if (!data.fatal || cancelled) return
            // Récupération automatique : coupure réseau → rechargement du flux,
            // erreur de décodage → récupération MSE. Trois essais avant l'erreur.
            if (hlsRecoveryAttempts < 3) {
              hlsRecoveryAttempts += 1
              setPlaybackMessage('Connexion au flux interrompue — nouvelle tentative…')
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                player.startLoad()
                return
              }
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                player.recoverMediaError()
                return
              }
            }
            setPlaybackFailed(true)
            setPlaybackMessage(`Erreur HLS : ${data.details ?? 'manifeste ou segments inaccessibles'}.`)
          }

          player.on(Hls.Events.MANIFEST_PARSED, onManifestParsed)
          player.on(Hls.Events.ERROR, onHlsError)
          player.loadSource(streamUrl)
          player.attachMedia(video)
        }).catch((error: unknown) => {
          if (!cancelled) {
            setPlaybackFailed(true)
            setPlaybackMessage(error instanceof Error ? error.message : 'Impossible de charger le lecteur HLS.')
          }
        })
        return
      }

      video.src = streamUrl
      video.load()
      if (!shouldAutoPlay) {
        setPlaybackMessage('Flux chargé — appuyez sur « Lire avec son ».')
      }
    }

    if (useNativeStreamProxy || (streamFormatIsKnown && !isEpisode)) {
      initializePlayer('', /\.(ts|m2ts)$/.test(streamPath))
    } else {
      const probe = isEpisode ? '&probe=1' : ''
      void apiFetch(apiUrl(`/api/stream-info?url=${encodeURIComponent(channel.stream)}${probe}`))
      .then(async (response) => {
        const result = (await response.json()) as {
          status?: number
          contentType?: string
          isTransportStream?: boolean
          error?: string
        }
        if (!response.ok) throw new Error(result.error ?? 'Le serveur ne peut pas joindre le fournisseur.')
        if (typeof result.status === 'number' && result.status >= 400) {
          throw new Error(`Le fournisseur refuse ce flux (HTTP ${result.status}). Vérifiez le lien ou vos accès.`)
        }
        initializePlayer(result.contentType ?? '', result.isTransportStream ?? false)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPlaybackFailed(true)
          setPlaybackMessage(error instanceof Error ? error.message : 'Impossible de vérifier le flux vidéo.')
        }
      })
    }

    return () => {
      cancelled = true
      hlsPlayer?.destroy()
      mpegtsPlayer?.destroy()
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
      mpegtsPlayerRef.current = null
      hlsPlayerRef.current = null
      video.pause()
      video.removeEventListener('loadedmetadata', handleMediaReady)
      video.removeAttribute('src')
      video.load()
    }
  }, [channel.stream, isEpisode, isLiveChannel, playbackRetryCount, shouldAutoPlay, streamUrl, useNativeStreamProxy])

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate
  }, [playbackRate])

  const changePlaybackRate = (rate: number) => {
    setPlaybackRate(rate)
    if (videoRef.current) videoRef.current.playbackRate = rate
  }

  const savePlaybackProgress = (force = false) => {
    const position = videoRef.current?.currentTime ?? 0
    if (!Number.isFinite(position) || position <= 0) return
    if (!force && position - lastProgressSentRef.current < 5) return
    lastProgressSentRef.current = position
    onPlaybackProgress?.(position)
  }

  const startPlayback = () => {
    if (!channel.stream) return

    const player = mpegtsPlayerRef.current
    if (player) {
      void Promise.resolve(player.play()).then(() => setPlaybackMessage('')).catch(() => {
        setPlaybackFailed(true)
        setPlaybackMessage('Lecture impossible. Vérifiez le flux et votre connexion.')
      })
      return
    }

    const video = videoRef.current
    if (video) {
      void video.play().then(() => setPlaybackMessage('')).catch(() => {
        setPlaybackFailed(true)
        setPlaybackMessage('Lecture impossible. Vérifiez le flux et votre connexion.')
      })
    }
  }

  const saveRecording = (recorder: MediaRecorder) => {
    const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || 'video/webm' })
    recordingChunksRef.current = []
    if (blob.size === 0) {
      setControlMessage('Aucune donnée vidéo n’a pu être enregistrée.')
      return
    }
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${channel.name.replace(/[<>:"/\\|?*]/g, '_')}.webm`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    setControlMessage('Enregistrement téléchargé.')
  }

  const toggleRecording = () => {
    const currentRecorder = recorderRef.current
    if (currentRecorder?.state === 'recording') {
      currentRecorder.stop()
      setIsRecording(false)
      return
    }

    const video = videoRef.current
    const capturableVideo = video as (HTMLVideoElement & { captureStream?: () => MediaStream }) | null
    if (
      !video ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      typeof capturableVideo?.captureStream !== 'function'
    ) {
      setControlMessage('Ce flux ne peut pas être enregistré dans ce navigateur.')
      return
    }

    try {
      const stream = capturableVideo.captureStream()
      const mimeType = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ].find((type) => MediaRecorder.isTypeSupported(type))
      if (!mimeType) {
        throw new Error('Ce navigateur ne prend pas en charge le format d’enregistrement requis.')
      }

      const recorder = new MediaRecorder(stream, { mimeType })
      recordingChunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data)
      }
      recorder.onstop = () => saveRecording(recorder)
      recorder.onerror = () => {
        setIsRecording(false)
        setControlMessage('L’enregistrement du flux a échoué.')
      }
      recorderRef.current = recorder
      recorder.start(1000)
      setIsRecording(true)
      setControlMessage('Enregistrement en cours…')
    } catch (error) {
      setControlMessage(error instanceof Error ? error.message : 'Impossible de démarrer l’enregistrement.')
    }
  }

  const toggleSubtitles = () => {
    const tracks = videoRef.current?.textTracks
    if (!tracks || tracks.length === 0) {
      setHasSubtitles(false)
      setControlMessage('Aucun sous-titre n’est fourni pour ce programme.')
      return
    }

    const enable = !subtitlesEnabled
    const foundSubtitle = setSubtitleTracksEnabled(tracks, enable)
    setHasSubtitles(foundSubtitle)
    setSubtitlesEnabled(enable && foundSubtitle)
    setControlMessage(foundSubtitle ? (enable ? 'Sous-titres activés.' : 'Sous-titres désactivés.') : 'Aucun sous-titre n’est fourni pour ce programme.')
  }

  const reconnectLiveStream = () => {
    const video = videoRef.current
    const player = mpegtsPlayerRef.current
    if (player) {
      player.unload()
      player.load()
      void Promise.resolve(player.play()).catch(() => {
        setPlaybackMessage('Impossible de reconnecter la chaîne en direct.')
      })
      return
    }

    const hlsPlayer = hlsPlayerRef.current
    if (hlsPlayer && video) {
      const livePosition = hlsPlayer.liveSyncPosition
      hlsPlayer.startLoad(-1)
      if (typeof livePosition === 'number' && Number.isFinite(livePosition)) {
        video.currentTime = livePosition
      }
      void video.play().catch(() => {
        setPlaybackMessage('Impossible de reconnecter la chaîne en direct.')
      })
      return
    }

    if (video) {
      video.src = streamUrl
      video.load()
      void video.play().catch(() => {
        setPlaybackMessage('Impossible de reconnecter la chaîne en direct.')
      })
    }
  }

  const handleMediaEnded = () => {
    if (!isLiveChannel) {
      onPlaybackProgress?.(0)
      lastProgressSentRef.current = 0
      return
    }

    // Chaîne en direct : on se reconnecte aussitôt au bord du direct au lieu
    // de rejouer en boucle le contenu déjà reçu.
    reconnectLiveStream()
  }

  // Surveillance anti-blocage : si l'image ne progresse plus alors que la lecture
  // est en cours (coupure réseau, flux figé), la connexion est relancée aussitôt
  // au lieu de laisser l'écran bloqué indéfiniment.
  useEffect(() => {
    if (!channel.stream) return
    const interval = window.setInterval(() => {
      const video = videoRef.current
      if (!video || video.paused || video.ended || video.seeking) return
      if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return
      const now = Date.now()
      if (now - lastMediaProgressAtRef.current < 30_000) return
      if (now - lastReconnectAtRef.current < 60_000) return
      lastReconnectAtRef.current = now
      lastMediaProgressAtRef.current = now
      setPlaybackFailed(false)
      setPlaybackMessage('Connexion instable — reconnexion automatique…')
      const resumeAt = isLiveChannel ? 0 : video.currentTime
      reconnectLiveStream()
      if (resumeAt > 1) {
        window.setTimeout(() => {
          const current = videoRef.current
          if (current && !current.paused) {
            try {
              current.currentTime = resumeAt
            } catch {
              // Certains flux refusent le déplacement : la lecture reprend au début.
            }
          }
        }, 1500)
      }
    }, 3_000)
    return () => window.clearInterval(interval)
  }, [channel.stream, isLiveChannel, streamUrl])

  return (
    <div className={`video-panel${compact ? ' video-panel-compact' : ''}`}>
      <div
        className="video-surface"
        ref={videoSurfaceRef}
        tabIndex={onToggleTheater ? 0 : undefined}
        role={onToggleTheater ? 'group' : undefined}
        onDoubleClick={(event) => {
          if (!onToggleTheater) return
          event.preventDefault()
          onToggleTheater()
        }}
        onKeyDown={(event) => {
          if (!onToggleTheater || event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return
          const now = Date.now()
          if (now - remoteFullscreenPressRef.current < 550) {
            event.preventDefault()
            remoteFullscreenPressRef.current = 0
            onToggleTheater()
          } else {
            remoteFullscreenPressRef.current = now
          }
        }}
        title={onToggleTheater ? 'Double-clic : basculer entre écran agrandi et affichage normal' : undefined}
      >
        {isVideoFullscreen && showFullscreenClock && (
          <LiveClock className="fullscreen-clock" />
        )}
        {channel.stream ? (
          <>
            <video
              ref={videoRef}
              controls
              playsInline
              preload="auto"
              autoPlay={shouldAutoPlay}
              muted={muted || soundBlocked}
              onTimeUpdate={() => {
                lastMediaProgressAtRef.current = Date.now()
                savePlaybackProgress()
              }}
              onPause={() => {
                setIsPlaying(false)
                savePlaybackProgress(true)
              }}
              onEnded={handleMediaEnded}
              onLoadedMetadata={() => {
                const tracks = videoRef.current?.textTracks
                setHasSubtitles(Boolean(tracks && Array.from(tracks).some((track) => track.kind === 'subtitles' || track.kind === 'captions')))
              }}
              onCanPlay={() => {
                if (!shouldAutoPlay) {
                  setPlaybackMessage('Flux chargé — appuyez sur Lecture pour démarrer le son et la vidéo.')
                }
              }}
              onPlaying={() => {
                lastMediaProgressAtRef.current = Date.now()
                setIsPlaying(true)
                setPlaybackFailed(false)
                setPlaybackMessage('')
                onPlaybackStart?.(channel)
              }}
              onError={() => {
                if (mpegtsPlayerRef.current) return
                const errors: Record<number, string> = {
                  1: 'La lecture a été interrompue.',
                  2: 'Erreur réseau pendant la récupération du flux.',
                  3: 'Le navigateur ne peut pas décoder ce flux vidéo.',
                  4: 'Le format de ce flux n’est pas pris en charge.',
                }
                setPlaybackFailed(true)
                setPlaybackMessage(errors[videoRef.current?.error?.code ?? 0] ?? 'Le flux ne répond pas ou son format n’est pas compatible.')
              }}
            />
            {playbackMessage && (
              <button
                type="button"
                className="playback-message"
                onClick={() => {
                  if (playbackFailed) {
                    setPlaybackFailed(false)
                    setPlaybackMessage('Nouvelle tentative de lecture…')
                    setPlaybackRetryCount((count) => count + 1)
                  } else {
                    startPlayback()
                  }
                }}
              >
                <Play size={17} />
                {playbackMessage}
              </button>
            )}
          </>
        ) : (
          <p className="empty-player-message">Sélectionnez un épisode ou un programme pour lancer la lecture.</p>
        )}
      </div>
      {!compact && <div className="video-toolbar">
        {channel.stream && (
          <>
            {channel.mediaType === 'movie' && (
              <div className="movie-playback-controls" aria-label="Commandes du film">
                <label className="playback-speed-control">
                  Vitesse
                  <select
                    value={playbackRate}
                    onChange={(event) => changePlaybackRate(Number(event.target.value))}
                    aria-label="Vitesse de lecture"
                  >
                    <option value={0.5}>0,5×</option>
                    <option value={1}>1×</option>
                    <option value={1.5}>1,5×</option>
                    <option value={2}>2×</option>
                    <option value={5}>5×</option>
                  </select>
                </label>
              </div>
            )}
            <button type="button" className="ghost-button" onClick={() => setShowInformation((visible) => !visible)}>
              <Info size={16} />
              Informations
            </button>
            <button
              type="button"
              className={isRecording ? 'primary-button recording-button' : 'ghost-button'}
              onClick={toggleRecording}
            >
              <CircleDot size={16} />
              {isRecording ? 'Arrêter et télécharger' : 'Enregistrer'}
            </button>
            <button
              type="button"
              className="ghost-button"
              aria-pressed={subtitlesEnabled}
              title={hasSubtitles ? 'Activer ou désactiver les sous-titres' : 'Les sous-titres dépendent du flux'}
              onClick={toggleSubtitles}
            >
              <Captions size={16} />
              {subtitlesEnabled ? 'Désactiver sous-titres' : 'Sous-titres'}
            </button>
          </>
        )}
      </div>}
      {!compact && controlMessage && <p className="player-control-message" role="status">{controlMessage}</p>}
      {!compact && showInformation && (
        <section className="player-information" aria-label="Informations du programme">
          <strong>{channel.name}</strong>
          <span>{informationLabel} · {channel.group} · {channel.quality}</span>
          {channel.mediaType === 'episode' && seriesName && (
            <p><b>Série :</b> {seriesName}</p>
          )}
          {isLiveChannel && epgProgram && (
            <div className="player-epg">
              <p>
                <b>En ce moment</b>
                <span className="player-epg-time">
                  {formatEpgTime(epgProgram.start)} – {formatEpgTime(epgProgram.stop)}
                </span>
              </p>
              <p><b>{epgProgram.title}</b></p>
              {epgProgram.description && <p>{epgProgram.description}</p>}
            </div>
          )}
          {isLiveChannel && nextEpgProgram && (
            <div className="player-epg next">
              <p>
                <b>À suivre</b>
                <span className="player-epg-time">{formatEpgTime(nextEpgProgram.start)}</span>
              </p>
              <p>{nextEpgProgram.title}</p>
            </div>
          )}
          {isLiveChannel && !epgProgram && !nextEpgProgram && (
            <p className="player-epg-empty">Aucune information d’émission disponible pour cette chaîne.</p>
          )}
          {hasChannelDescription && (
            <p><b>{isLiveChannel ? 'Émission / programme' : 'Synopsis'}</b> : {channelDescription}</p>
          )}
        </section>
      )}
    </div>
  )
}

/* ---------- EPG Grid Component (Guide TV) ---------- */
function EPGGrid({
  channels,
  epgData,
  epgOffset,
  onOffsetChange,
  onChannelClick,
  epgLoading,
  epgError,
}: {
  channels: Channel[]
  epgData: Map<string, EpgProgram[]>
  epgOffset: number
  onOffsetChange: (offset: number) => void
  onChannelClick: (channel: Channel) => void
  epgLoading: boolean
  epgError: string
}) {
  const now = new Date()
  const baseTime = new Date(now.getTime() + epgOffset * 3600 * 1000)
  baseTime.setMinutes(0, 0, 0)
  
  const slots: Date[] = []
  for (let i = 0; i <= EPG_SLOTS; i++) {
    slots.push(new Date(baseTime.getTime() + i * EPG_SLOT_MINUTES * 60000))
  }
  
  const liveChannels = channels.filter(c => getChannelMediaType(c) === 'live')
  const visibleChannels = liveChannels.slice(0, 80)
  
  const handleProgramClick = (channel: Channel, program: EpgProgram) => {
    const currentProgram = getCurrentProgram(getEpgForChannel(epgData, channel.id, channel.tvgId, channel.epgId))
    if (currentProgram && currentProgram.id === program.id) {
      onChannelClick(channel)
    }
  }
  
  return (
    <section className="epg-grid-pane" role="region" aria-label="Guide TV">
      <header className="epg-grid-header">
        <div className="epg-time-nav">
          <button
            type="button"
            className="ghost-button"
            onClick={() => onOffsetChange(epgOffset - 2)}
            aria-label="Reculer de 2 heures"
          >
            ◀ -2h
          </button>
          <div className="epg-current-time">
            <span>{formatEpgDate(baseTime.getTime() / 1000)}</span>
            <span>{baseTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} → {(slots[slots.length - 1]).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => onOffsetChange(0)}
            aria-label="Maintenant"
          >
            ● Maintenant
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => onOffsetChange(epgOffset + 2)}
            aria-label="Avancer de 2 heures"
          >
            +2h ▶
          </button>
        </div>
      </header>
      
      <div className="epg-grid-wrapper">
        <div className="epg-grid-header-row">
          <div className="epg-channel-header">CHAÎNE</div>
          {slots.slice(0, -1).map((slot, idx) => (
            <div key={idx} className="epg-time-header">
              {slot.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
            </div>
          ))}
        </div>
        
        <div className="epg-grid-body">
          {visibleChannels.map((channel) => {
            const programs = getEpgForChannel(epgData, channel.id, channel.tvgId, channel.epgId)
            const currentProgram = getCurrentProgram(programs)
            
            return (
              <div key={channel.id} className="epg-row">
                <button
                  type="button"
                  className="epg-channel-cell"
                  onClick={() => onChannelClick(channel)}
                  aria-label={channel.name}
                >
                  {channel.logo && channel.logo.startsWith('http') ? (
                    <img src={channel.logo} alt="" loading="lazy" />
                  ) : (
                    <span className="epg-channel-logo-fallback">{channel.name.slice(0, 2).toUpperCase()}</span>
                  )}
                  <span className="epg-channel-name">{channel.name}</span>
                </button>
                {slots.slice(0, -1).map((slotStart, slotIdx) => {
                  const slotEnd = slots[slotIdx + 1]
                  const slotStartSec = slotStart.getTime() / 1000
                  const slotEndSec = slotEnd.getTime() / 1000
                  
                  const programInSlot = programs.find(p => 
                    p.start < slotEndSec && p.stop > slotStartSec
                  )
                  
                  const isNow = currentProgram && currentProgram.id === programInSlot?.id
                  
                  return (
                    <button
                      key={slotIdx}
                      type="button"
                      className={`epg-program-cell ${isNow ? 'now' : ''} ${programInSlot ? 'has-program' : ''}`}
                      onClick={() => programInSlot && handleProgramClick(channel, programInSlot)}
                      disabled={!programInSlot}
                      aria-label={programInSlot ? `${programInSlot.title} ${formatEpgTime(programInSlot.start)} - ${formatEpgTime(programInSlot.stop)}` : 'Aucun programme'}
                    >
                      {programInSlot && (
                        <>
                          <span className="epg-program-time">{formatEpgTime(programInSlot.start)}</span>
                          <span className="epg-program-title">{programInSlot.title}</span>
                        </>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      
      {epgData.size === 0 && !epgLoading && (
        <div className="epg-empty">
          <p>Aucune donnée EPG disponible pour cette playlist.</p>
          {epgError && <p className="epg-empty-error">{epgError}</p>}
          <p className="epg-empty-hint">Importez une playlist Xtream avec EPG ou ajoutez une URL XMLTV dans les paramètres de la playlist.</p>
        </div>
      )}
      
      {epgLoading && (
        <div className="epg-loading">Chargement du guide TV…</div>
      )}
    </section>
  )
}

function App() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [selectedGroup, setSelectedGroup] = useState('All')
  // Case des groupes : fermée par défaut, s'ouvre au clic et se referme au choix
  // (liste scrollable, pour ne pas manger l'espace de l'écran).
  const [groupPickerOpen, setGroupPickerOpen] = useState(false)
  const groupPickerRef = useRef<HTMLDivElement | null>(null)
  const [selectedChannelId, setSelectedChannelId] = useState(EMPTY_CHANNEL.id)
  const [playOnSelectChannelId, setPlayOnSelectChannelId] = useState('')
  // Lecture stoppée à l'entrée des onglets Films / Séries : le lecteur est démonté
  // et l'onglet affiche la grille d'affiches au lieu de la chaîne en cours.
  const [playbackStopped, setPlaybackStopped] = useState(false)
  // Mode plein écran TV (dit « cinéma ») : la chaîne occupe tout l'écran et une flèche
  // permet de revenir à l'affichage réduit. Purement visuel : le lecteur n'est pas remonté,
  // donc la diffusion n'est jamais coupée.
  const [isTheaterMode, setIsTheaterMode] = useState(false)
  // Détection du double appui (double clic souris ou double OK télécommande) sur une chaîne.
  const channelPressRef = useRef<{ id: string; time: number }>({ id: '', time: 0 })
  // Fiche d'information d'un film / d'une série (clic sur une affiche).
  const [selectedVod, setSelectedVod] = useState<Channel | null>(null)
  // Pagination de la grille d'affiches (les catalogues peuvent contenir des dizaines
  // de milliers de films : on n'en monte qu'une page dans le DOM).
  const [vodGridCount, setVodGridCount] = useState(120)
  const [playbackHistory, setPlaybackHistory] = useState<PlaybackHistoryEntry[]>([])
  const [multiScreenCount, setMultiScreenCount] = useState(1)
  const [multiScreenChannelIds, setMultiScreenChannelIds] = useState<string[]>([])
  const [multiScreenAudioIndex, setMultiScreenAudioIndex] = useState<number | null>(null)
  const [selectedMultiScreenIndex, setSelectedMultiScreenIndex] = useState(0)
  const [historyCategory, setHistoryCategory] = useState<'all' | 'live' | 'movie' | 'series'>('all')
  const [search, setSearch] = useState('')
  // EPG Guide TV
  const [epgData, setEpgData] = useState<Map<string, EpgProgram[]>>(new Map())
  const [epgOffset, setEpgOffset] = useState(0)
  const [epgLoading, setEpgLoading] = useState(false)
  const [epgError, setEpgError] = useState('')
  // Films par catégorie
  const [selectedMovieCategory, setSelectedMovieCategory] = useState('All')
  // Listes de 30 000 chaînes : la saisie reste fluide, le filtrage est calculé en différé.
  const deferredSearch = useDeferredValue(search)
  // Horloge EPG : rafraîchie toutes les 30 s seulement (au lieu de chaque seconde)
  // pour éviter de relancer le rendu complet de l'application.
  const [epgNow, setEpgNow] = useState(() => Math.floor(Date.now() / 1000))
  const [favorites, setFavorites] = useState<string[]>([])
  const [activeNav, setActiveNav] = useState('TV en direct')
  const [showPlaylistManager, setShowPlaylistManager] = useState(false)
  const [showSpeedTest, setShowSpeedTest] = useState(false)
  const [isTestingSpeed, setIsTestingSpeed] = useState(false)
  const [speedTestResult, setSpeedTestResult] = useState<{ latency: number; download: number; upload: number } | null>(null)
  const [speedTestError, setSpeedTestError] = useState('')
  const [itemContextMenu, setItemContextMenu] = useState<ItemContextMenu | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [viewingEpisodes, setViewingEpisodes] = useState<{ seriesId: string; seriesName: string; episodes: Channel[] } | null>(null)
  const [isLoadingEpisodes, setIsLoadingEpisodes] = useState(false)
  const seriesRequestId = useRef(0)
  const [isLoadingVodInfo, setIsLoadingVodInfo] = useState(false)
  const vodInfoRequestId = useRef(0)
  const [authStatus, setAuthStatus] = useState<'loading' | 'signedIn'>('loading')
  const isNativeApp = Capacitor.isNativePlatform()
  const appShellRef = useRef<HTMLDivElement | null>(null)
  const apiBaseUrl = getApiBaseUrl()
  const [user, setUser] = useState<UserAccount | null>(null)
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [activePlaylistId, setActivePlaylistId] = useState('')
  const [notice, setNotice] = useState('')
  const channelListRef = useRef<HTMLDivElement | null>(null)
  const [channelScrollTop, setChannelScrollTop] = useState(0)
  const [importMode, setImportMode] = useState<'file' | 'url' | 'xtream'>('file')
  const [m3uUrl, setM3uUrl] = useState('')
  const [m3uName, setM3uName] = useState('Playlist M3U')
  const [xtreamServer, setXtreamServer] = useState('')
  const [xtreamUsername, setXtreamUsername] = useState('')
  const [xtreamPassword, setXtreamPassword] = useState('')
  const [xtreamName, setXtreamName] = useState('Ma playlist Xtream')
  const [isImportingRemote, setIsImportingRemote] = useState(false)
  const [isImportingFile, setIsImportingFile] = useState(false)
  const [importElapsed, setImportElapsed] = useState(0)
  const [refreshingPlaylistId, setRefreshingPlaylistId] = useState('')
  const [updatingPlaylistStatusId, setUpdatingPlaylistStatusId] = useState('')
  const [editingPlaylist, setEditingPlaylist] = useState<Playlist | null>(null)
  const [editPlaylistName, setEditPlaylistName] = useState('')
  const [editPlaylistUrl, setEditPlaylistUrl] = useState('')
  const [editXtreamUsername, setEditXtreamUsername] = useState('')
  const [editXtreamPassword, setEditXtreamPassword] = useState('')
  const [editSourceDetails, setEditSourceDetails] = useState<PlaylistSourceDetails | null>(null)
  const [isEditPasswordVisible, setIsEditPasswordVisible] = useState(false)
  const [isImportPasswordVisible, setIsImportPasswordVisible] = useState(true)
  const importFileInputRef = useRef<HTMLInputElement | null>(null)
  const editFileInputRef = useRef<HTMLInputElement | null>(null)
  const [editPlaylistChannels, setEditPlaylistChannels] = useState<Channel[] | null>(null)
  const [isUpdatingPlaylist, setIsUpdatingPlaylist] = useState(false)
  const playbackStateKey =
    user && activePlaylistId ? getPlaybackStateKey(user.id, activePlaylistId) : ''
  const activePlaylist = playlists.find((playlist) => playlist.id === activePlaylistId)
  const activePlaylistIdRef = useRef(activePlaylistId)
  const selectedChannelIdRef = useRef(selectedChannelId)
  const autoRefreshedPlaylistIds = useRef(new Set<string>())

  useEffect(() => {
    activePlaylistIdRef.current = activePlaylistId
    selectedChannelIdRef.current = selectedChannelId
  }, [activePlaylistId, selectedChannelId])

  useEffect(() => {
    if (!isNativeApp || authStatus !== 'signedIn') return

    const focusInitialNavigation = window.requestAnimationFrame(() => {
      appShellRef.current?.querySelector<HTMLButtonElement>('.nav-item.active')?.focus()
    })
    const handleRemoteNavigation = (event: KeyboardEvent) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
      const shell = appShellRef.current
      const current = document.activeElement
      if (!shell || !(current instanceof HTMLElement) || !shell.contains(current)) return
      if (current.matches('input, textarea, select, [contenteditable="true"]')) return

      const focusScope = shell.querySelector<HTMLElement>('.modal-backdrop') ?? shell
      const currentBounds = current.getBoundingClientRect()
      const currentX = currentBounds.left + currentBounds.width / 2
      const currentY = currentBounds.top + currentBounds.height / 2
      const direction = event.key
      const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight'
      const nodes = focusScope.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )
      let best: HTMLElement | null = null
      let bestScore = Infinity
      for (const element of nodes) {
        if (element === current || element.closest('[aria-hidden="true"]')) continue
        const bounds = element.getBoundingClientRect()
        if (bounds.width === 0 || bounds.height === 0) continue
        const x = bounds.left + bounds.width / 2
        const y = bounds.top + bounds.height / 2
        const dx = x - currentX
        const dy = y - currentY
        const primary = horizontal ? (direction === 'ArrowRight' ? dx : -dx) : (direction === 'ArrowDown' ? dy : -dy)
        if (primary <= 2) continue
        const perpendicular = horizontal ? Math.abs(dy) : Math.abs(dx)
        const score = primary + perpendicular * 2.5
        if (score < bestScore) {
          bestScore = score
          best = element
        }
      }

      if (best) {
        event.preventDefault()
        best.focus()
        best.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    }

    document.addEventListener('keydown', handleRemoteNavigation, true)
    return () => {
      window.cancelAnimationFrame(focusInitialNavigation)
      document.removeEventListener('keydown', handleRemoteNavigation, true)
    }
  }, [authStatus, isNativeApp])

  // Navigation télécommande : tout élément qui prend le focus est ramené dans la zone
  // visible en douceur, pour un déplacement fluide entre les menus.
  useEffect(() => {
    if (!isNativeApp) return
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    }
    document.addEventListener('focusin', handleFocusIn)
    return () => document.removeEventListener('focusin', handleFocusIn)
  }, [isNativeApp])

  // Sur télécommande, appuyer sur OK dans un champ de saisie (recherche, import…)
  // garde le champ actif et fait apparaître le clavier virtuel.
  useEffect(() => {
    if (!isNativeApp) return
    const handleInputActivate = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        event.preventDefault()
        target.focus()
        try {
          target.setSelectionRange(target.value.length, target.value.length)
        } catch {
          // Certains types de champ (url, number…) n'autorisent pas la sélection.
        }
      }
    }
    document.addEventListener('keydown', handleInputActivate, true)
    return () => document.removeEventListener('keydown', handleInputActivate, true)
  }, [isNativeApp])

  // Plein écran TV : la touche Retour / Échap ferme le mode cinéma.
  useEffect(() => {
    if (!isTheaterMode) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Backspace' || event.key === 'GoBack') {
        event.preventDefault()
        setIsTheaterMode(false)
      }
    }
    document.addEventListener('keydown', handleEscape, true)
    return () => document.removeEventListener('keydown', handleEscape, true)
  }, [isTheaterMode])

  // Case des groupes : Échap ou clic dehors referme la liste.
  useEffect(() => {
    if (!groupPickerOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      if (groupPickerRef.current && !groupPickerRef.current.contains(event.target as Node)) {
        setGroupPickerOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setGroupPickerOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [groupPickerOpen])

  useLayoutEffect(() => {
    if (!groupPickerOpen) return
    const list = groupPickerRef.current?.querySelector<HTMLElement>('.group-options')
    const selected = list?.querySelector<HTMLElement>('.group-option.selected')
    if (!list || !selected) return
    const listRect = list.getBoundingClientRect()
    const selectedRect = selected.getBoundingClientRect()
    if (selectedRect.top < listRect.top) list.scrollTop -= listRect.top - selectedRect.top
    else if (selectedRect.bottom > listRect.bottom) list.scrollTop += selectedRect.bottom - listRect.bottom
  }, [groupPickerOpen, selectedGroup])

  // Le mode cinéma ne concerne que le direct : on le quitte dès qu'un autre écran s'ouvre.
  useEffect(() => {
    if (isTheaterMode && (activeNav === 'Multi-écran' || activeNav === 'Films' || activeNav === 'Séries')) {
      setIsTheaterMode(false)
    }
  }, [activeNav, isTheaterMode])

  // Quitter l'application (appui long sur la touche Retour ou sur le bouton à l'écran).
  const exitApp = useCallback(() => {
    const bridge = (window as unknown as { AndroidTv?: { exit?: () => void } }).AndroidTv
    bridge?.exit?.()
  }, [])

  // Bouton Retour : ferme l'écran courant puis remonte les menus précédents.
  const handleBackNavigation = useCallback(() => {
    if (itemContextMenu) { setItemContextMenu(null); return }
    if (showSpeedTest) { setShowSpeedTest(false); return }
    if (editingPlaylist) { setEditingPlaylist(null); setEditPlaylistChannels(null); return }
    if (selectedVod) { setSelectedVod(null); return }
    if (showPlaylistManager) { setShowPlaylistManager(false); return }
    if (isTheaterMode) { setIsTheaterMode(false); return }
    if (viewingEpisodes) {
      setViewingEpisodes(null)
      setSelectedChannelId(`series-${viewingEpisodes.seriesId}`)
      return
    }
    if (activeNav !== 'TV en direct') {
      setActiveNav('TV en direct')
      setPlaybackStopped(false)
    }
  }, [
    activeNav,
    editingPlaylist,
    isTheaterMode,
    itemContextMenu,
    selectedVod,
    setItemContextMenu,
    setShowSpeedTest,
    showPlaylistManager,
    showSpeedTest,
    viewingEpisodes,
  ])

  useEffect(() => {
    window.addEventListener('iptvhub:back', handleBackNavigation)
    return () => window.removeEventListener('iptvhub:back', handleBackNavigation)
  }, [handleBackNavigation])

  // Appui long sur le bouton Retour à l'écran : ferme l'application.
  const backLongPressRef = useRef<number | undefined>(undefined)
  const startBackButtonPress = useCallback(() => {
    backLongPressRef.current = window.setTimeout(() => {
      backLongPressRef.current = undefined
      exitApp()
    }, 800)
  }, [exitApp])
  const endBackButtonPress = useCallback(() => {
    if (backLongPressRef.current !== undefined) {
      window.clearTimeout(backLongPressRef.current)
      backLongPressRef.current = undefined
      handleBackNavigation()
    }
  }, [handleBackNavigation])
  const cancelBackButtonPress = useCallback(() => {
    if (backLongPressRef.current !== undefined) {
      window.clearTimeout(backLongPressRef.current)
      backLongPressRef.current = undefined
    }
  }, [])

  // Minuterie affichée pendant la lecture/importation d'une playlist M3U.
  useEffect(() => {
    if (!isImportingRemote && !isImportingFile) {
      setImportElapsed(0)
      return
    }
    const startedAt = Date.now()
    setImportElapsed(0)
    const timer = window.setInterval(() => {
      setImportElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 500)
    return () => window.clearInterval(timer)
  }, [isImportingRemote, isImportingFile])

  // Minuterie de la page d'ouverture (lecture de la playlist au démarrage).
  const [bootElapsed, setBootElapsed] = useState(0)
  useEffect(() => {
    if (authStatus !== 'loading') return
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setBootElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 500)
    return () => window.clearInterval(timer)
  }, [authStatus])

  const isGlobalSearch =
    Boolean(deferredSearch.trim()) &&
    !['Historique', 'Enregistrements', 'Multi-écran', 'Playlists'].includes(activeNav) &&
    !viewingEpisodes
  const favoriteGroupNames = useMemo(
    () => activePlaylist?.customizations?.favoriteGroups ?? [],
    [activePlaylist],
  )
  const favoriteChannelStreams = useMemo(
    () => activePlaylist?.customizations?.favoriteChannels ?? [],
    [activePlaylist],
  )
  const hiddenChannelStreams = useMemo(
    () => activePlaylist?.customizations?.hiddenChannels ?? [],
    [activePlaylist],
  )
  const hiddenChannelItems = useMemo(
    () => activePlaylist?.channels.filter((channel) => hiddenChannelStreams.includes(channel.stream)) ?? [],
    [activePlaylist, hiddenChannelStreams],
  )

  useEffect(() => {
    const timer = window.setInterval(
      () => setEpgNow(Math.floor(Date.now() / 1000)),
      30000,
    )
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (user && activePlaylistId) {
      localStorage.setItem(getActivePlaylistKey(user.id), activePlaylistId)
    }
  }, [activePlaylistId, user])

  useEffect(() => {
    if (isNativeApp && !apiBaseUrl) {
      setUser({ id: 'local-device', email: '' })
      setAuthStatus('signedIn')
      return
    }
    let cancelled = false
    let accessKeyRefused = false

    apiFetch(apiUrl('/api/auth/me'))
      .then(async (response) => {
        if (response.status === 401) {
          accessKeyRefused = true
          localStorage.removeItem(API_ACCESS_KEY)
          throw new Error('Code d’accès refusé.')
        }
        if (!response.ok) {
          throw new Error('Impossible de vérifier la session.')
        }
        return (await response.json()) as { user: UserAccount | null; streamTicket?: string }
      })
      .then((result) => {
        if (cancelled) return
        if (result.streamTicket) localStorage.setItem(STREAM_TICKET_KEY, result.streamTicket)
        if (result.user) {
          setUser(result.user)
          setAuthStatus('signedIn')
        } else {
          throw new Error('Le profil local n’a pas pu être initialisé.')
        }
      })
      .catch(() => {
        if (cancelled) return
        setUser({ id: 'local-device', email: '' })
        setNotice(accessKeyRefused
          ? 'Mode autonome : le serveur IPTV Hub n’a pas accepté le code d’accès enregistré.'
          : apiBaseUrl
            ? 'Serveur IPTV Hub inaccessible. L’application continue en mode autonome.'
            : 'Serveur local indisponible. Vérifiez que IPTV Hub est lancé sur cet appareil.')
        setAuthStatus('signedIn')
      })

    return () => {
      cancelled = true
    }
  }, [apiBaseUrl, isNativeApp])

  useEffect(() => {
    if (authStatus !== 'signedIn' || !user) return

    let cancelled = false
    apiFetch(apiUrl('/api/playlists'))
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Impossible de charger vos playlists.')
        }
        return (await response.json()) as { playlists: Playlist[] }
      })
      .then(async ({ playlists: savedPlaylists }) => {
        if (cancelled) return
        setPlaylists(savedPlaylists)
        if (savedPlaylists.length > 0) {
          const rememberedPlaylistId = localStorage.getItem(getActivePlaylistKey(user.id))
          const availablePlaylists = savedPlaylists.filter((item) => !item.suspended)
          const playlist =
            availablePlaylists.find((item) => item.id === rememberedPlaylistId) ??
            availablePlaylists[0]
          if (!playlist) {
            localStorage.removeItem(getActivePlaylistKey(user.id))
            setActivePlaylistId('')
            setChannels([])
            setSelectedChannelId('')
            setPlayOnSelectChannelId('')
            setShowPlaylistManager(true)
            setNotice('Toutes vos playlists sont suspendues. Réactivez-en une pour reprendre la lecture.')
            return
          }
          const bookmark = readPlaybackState(getPlaybackStateKey(user.id, playlist.id))
          setPlaybackHistory(bookmark?.history ?? [])
          const defaultChannel =
            playlist.channels.find((channel) => getChannelMediaType(channel) === 'live') ??
            playlist.channels[0]
          setActivePlaylistId(playlist.id)
          setChannels(playlist.channels)
          setFavorites(readFavorites(getFavoritesKey(user.id, playlist.id)))
          setSelectedGroup('All')
          setPlayOnSelectChannelId('')
          setActiveNav('TV en direct')

          const preferredLiveId = bookmark?.mediaType === 'live'
            ? bookmark.channelId
            : bookmark?.history.find((entry) => entry.mediaType === 'live')?.channelId
          const restoredLive = playlist.channels.find(
            (channel) => channel.id === preferredLiveId && getChannelMediaType(channel) === 'live',
          ) ?? defaultChannel
          if (restoredLive && getChannelMediaType(restoredLive) === 'live') {
            setSelectedChannelId(restoredLive.id)
            setPlayOnSelectChannelId(restoredLive.id)
            setSelectedGroup(restoredLive.group)
            setPlaybackStopped(false)
            return
          }

          if (bookmark?.mediaType === 'episode' && bookmark.seriesId) {
            try {
              const response = await apiFetch(
                apiUrl(`/api/playlists/${encodeURIComponent(playlist.id)}/series/${encodeURIComponent(bookmark.seriesId)}/episodes`),
                { method: 'POST' },
              )
              const result = (await response.json()) as { episodes?: Channel[]; error?: string }
              if (!response.ok || !result.episodes) {
                throw new Error(result.error ?? 'Impossible de restaurer le dernier épisode.')
              }
              if (cancelled) return
              const episodes = result.episodes
              const episode = episodes.find((item) => item.id === bookmark.channelId) ?? episodes[0]
              if (episode) {
                setViewingEpisodes({
                  seriesId: bookmark.seriesId,
                  seriesName: bookmark.seriesName ?? episode.name,
                  episodes,
                })
                setActiveNav('Séries')
                setSelectedChannelId(episode.id)
                setSelectedGroup(episode.group)
                setPlayOnSelectChannelId(episode.id)
                return
              }
            } catch (error) {
              if (!cancelled) {
                setNotice(error instanceof Error ? error.message : 'Impossible de restaurer le dernier épisode.')
              }
            }
          } else if (bookmark) {
            const savedChannel = playlist.channels.find((channel) => channel.id === bookmark.channelId)
            if (savedChannel) {
              setSelectedChannelId(savedChannel.id)
              setPlayOnSelectChannelId(savedChannel.id)
              setPlaybackStopped(false)
              setActiveNav(bookmark.mediaType === 'movie' ? 'Films' : 'TV en direct')
              setSelectedGroup(savedChannel.group)
              return
            }
          }

          if (defaultChannel) {
            setSelectedChannelId(defaultChannel.id)
            setPlayOnSelectChannelId(
              getChannelMediaType(defaultChannel) === 'live' ? defaultChannel.id : '',
            )
            setSelectedGroup(defaultChannel.group)
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setNotice(error instanceof Error ? error.message : 'Erreur lors du chargement des playlists.')
        }
      })

    return () => {
      cancelled = true
    }
  }, [authStatus, user])

  // Au démarrage, actualiser les playlists distantes sans bloquer l'ouverture.
  // Différé de 15 s pour laisser la lecture se stabiliser d'abord.
  useEffect(() => {
    const playlist = activePlaylist
    const canRefresh = playlist?.sourceType === 'xtream'
      ? Boolean(playlist.provider)
      : playlist?.sourceType === 'm3u' && Boolean(playlist.m3uUrl)
    if (authStatus !== 'signedIn' || !playlist || !canRefresh) return
    if (autoRefreshedPlaylistIds.current.has(playlist.id)) return
    const playlistId = playlist.id
    autoRefreshedPlaylistIds.current.add(playlistId)
    let cancelled = false
    const timer = setTimeout(() => {
      void apiFetch(apiUrl(`/api/playlists/${encodeURIComponent(playlistId)}/refresh-xtream`), { method: 'POST' })
      .then(async (response) => {
        const result = (await response.json()) as { playlist?: Playlist; error?: string }
        if (!response.ok || !result.playlist) throw new Error(result.error ?? 'Actualisation automatique impossible.')
        return result.playlist
      })
      .then((updated) => {
        if (cancelled) return
        setPlaylists((items) => items.map((item) => item.id === updated.id ? updated : item))
        if (activePlaylistIdRef.current === playlistId) {
          setChannels(updated.channels)
          const lastChannel = updated.channels.find((channel) => channel.id === selectedChannelIdRef.current)
          if (lastChannel) setSelectedGroup(lastChannel.group)
          setNotice('Films et séries actualisés au démarrage.')
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setNotice(error instanceof Error ? error.message : 'Le catalogue n’a pas pu être actualisé.')
      })
    }, 15_000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [activePlaylist, authStatus])

  // Chargement EPG quand la playlist active change
  useEffect(() => {
    if (!activePlaylistId) return
    let cancelled = false
    setEpgLoading(true)
    setEpgError('')
    loadEpgForActivePlaylist(activePlaylistId)
      .then(epgMap => {
        if (!cancelled) {
          setEpgData(epgMap ?? new Map())
          setEpgLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEpgData(new Map())
          setEpgLoading(false)
          setEpgError('Guide TV indisponible pour cette playlist.')
        }
      })
    return () => { cancelled = true }
  }, [activePlaylistId])

  // La source ne dépend QUE de l'onglet choisi : la rattacher à la recherche faisait
  // recalculer les 300 000 chaînes, les 1 300 groupes et leurs lignes à chaque frappe.
  const visibleChannels = useMemo(() => {
    if (viewingEpisodes) return viewingEpisodes.episodes
    const sourceChannels = channels
    if (activeNav === 'Favoris') {
      return sourceChannels.filter(
        (channel) =>
          favorites.includes(channel.id) ||
          favoriteChannelStreams.includes(channel.stream) ||
          favoriteGroupNames.includes(channel.group),
      )
    }
    if (activeNav === 'Films') {
      let movies = getMediaTypeBuckets(sourceChannels).movie
      if (movies.length === 0) movies = sourceChannels
      if (selectedMovieCategory !== 'All') {
        movies = movies.filter(m => m.group === selectedMovieCategory)
      }
      return movies
    }
    if (activeNav === 'Séries') {
      return getMediaTypeBuckets(sourceChannels).series
    }
    if (activeNav === 'TV en direct') {
      return getMediaTypeBuckets(sourceChannels).live
    }
    if (activeNav === 'Multi-écran') {
      return getMediaTypeBuckets(sourceChannels).live
    }
    if (activeNav === 'Historique') {
      return playbackHistory.map((entry) => ({
        id: entry.channelId,
        name: entry.name,
        group: entry.group,
        logo: entry.logo,
        stream: '',
        epg: '',
        quality: entry.quality,
        isLive: entry.mediaType === 'live',
        isFavorite: false,
        mediaType: entry.mediaType,
        ...(entry.seriesId ? { seriesId: entry.seriesId } : {}),
      }))
    }
    if (activeNav === 'Enregistrements') {
      return []
    }
    return sourceChannels
  }, [
    activeNav,
    channels,
    favorites,
    favoriteChannelStreams,
    favoriteGroupNames,
    playbackHistory,
    selectedMovieCategory,
    viewingEpisodes,
  ])

  // Extraction des catégories de films uniques
  const movieCategories = useMemo(() => {
    const movies = getMediaTypeBuckets(channels).movie
    const pool = movies.length > 0 ? movies : channels
    const categories = new Set<string>()
    for (const item of pool) {
      if (item.group) {
        categories.add(item.group)
      }
    }
    return ['All', ...Array.from(categories).sort((a, b) => a.localeCompare(b, 'fr'))]
  }, [channels])

  const liveChannels = useMemo(() => getMediaTypeBuckets(channels).live, [channels])

  // Grille d'affiches Films / Séries (hors recherche globale et liste d'épisodes).
  const isVodGrid = (activeNav === 'Films' || activeNav === 'Séries') && !viewingEpisodes && !isGlobalSearch
  const isVodCatalogLayout = isVodGrid && playbackStopped

  useEffect(() => {
    setVodGridCount(120)
  }, [activeNav, deferredSearch, selectedGroup, activePlaylistId])

  const hiddenGroupNames = useMemo(
    () => activePlaylist?.customizations?.hiddenGroups ?? [],
    [activePlaylist],
  )
  const qualityChannels = useMemo(
    () => visibleChannels.filter(
      (channel) =>
        !hiddenGroupNames.includes(channel.group) &&
        !hiddenChannelStreams.includes(channel.stream),
    ),
    [hiddenChannelStreams, hiddenGroupNames, visibleChannels],
  )

  // Pendant une recherche globale on interroge toutes les chaînes sans toucher aux listes
  // dérivées : les groupes et leur affichage restent en place, seule la liste filtrée change.
  const allQualityChannels = useMemo(() => channels.filter(
    (channel) =>
      !hiddenGroupNames.includes(channel.group) &&
      !hiddenChannelStreams.includes(channel.stream),
  ), [channels, hiddenChannelStreams, hiddenGroupNames])

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>([['All', qualityChannels.length]])
    for (const channel of qualityChannels) {
      counts.set(channel.group, (counts.get(channel.group) ?? 0) + 1)
    }
    return counts
  }, [qualityChannels])

  const groups = useMemo(
    () => [...groupCounts.keys()].filter((group) => group !== 'All'),
    [groupCounts],
  )

  const searchResultGroups = useMemo(() => {
    if (!isGlobalSearch) return []
    const needle = deferredSearch.trim().toLowerCase()
    const maxVisibleResults = 80
    const live: Channel[] = []
    const movies: Channel[] = []
    const series: Channel[] = []
    let liveCount = 0
    let movieCount = 0
    let seriesCount = 0
    for (const channel of allQualityChannels) {
      if (!getChannelLabel(channel).includes(needle)) continue
      const mediaType = getChannelMediaType(channel)
      if (mediaType === 'live') {
        liveCount += 1
        if (live.length < maxVisibleResults) live.push(channel)
      } else if (mediaType === 'movie') {
        movieCount += 1
        if (movies.length < maxVisibleResults) movies.push(channel)
      } else {
        seriesCount += 1
        if (series.length < maxVisibleResults) series.push(channel)
      }
    }
    return [
      { type: 'live' as const, label: 'Chaînes en direct', channels: live, total: liveCount },
      { type: 'movie' as const, label: 'Films', channels: movies, total: movieCount },
      { type: 'series' as const, label: 'Séries', channels: series, total: seriesCount },
    ].filter((group) => group.total > 0)
  }, [allQualityChannels, deferredSearch, isGlobalSearch])
  const globalSearchResultCount = searchResultGroups.reduce((total, group) => total + group.total, 0)

  const filteredChannels = useMemo(() => {
    if (isGlobalSearch) return searchResultGroups.flatMap((group) => group.channels)
    const needle = deferredSearch.trim().toLowerCase()
    // Aucun groupe sélectionné + recherche vide : la liste est déjà prête, on ne la recopie pas.
    if (needle === '' && selectedGroup === 'All') return qualityChannels

    return qualityChannels.filter((channel) => {
      const matchesGroup = selectedGroup === 'All' || channel.group === selectedGroup
      const matchesSearch = needle === '' || getChannelLabel(channel).includes(needle)

      return matchesGroup && matchesSearch
    })
  }, [deferredSearch, isGlobalSearch, qualityChannels, searchResultGroups, selectedGroup])

  // Au démarrage (et à chaque changement de chaîne), la liste défile jusqu'à la chaîne lue
  // si elle est hors champ : on retrouve le même groupe et le même nom de chaîne.
  useEffect(() => {
    if (isGlobalSearch || selectedGroup === 'All') return
    const index = filteredChannels.findIndex((channel) => channel.id === selectedChannelId)
    if (index < 0) return
    const list = channelListRef.current
    if (!list || list.clientHeight === 0) return
    const rowTop = index * CHANNEL_ROW_HEIGHT
    const rowBottom = rowTop + CHANNEL_ROW_HEIGHT
    if (rowTop >= list.scrollTop && rowBottom <= list.scrollTop + list.clientHeight) return
    const target = Math.max(0, rowTop - list.clientHeight / 2 + CHANNEL_ROW_HEIGHT / 2)
    list.scrollTop = target
    setChannelScrollTop(target)
  }, [filteredChannels, isGlobalSearch, selectedChannelId, selectedGroup])

  const filteredHistory = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase()
    return playbackHistory.filter((entry) => {
      const matchesSearch = needle === '' || `${entry.name} ${entry.group} ${entry.seriesName ?? ''}`
        .toLowerCase()
        .includes(needle)
      const matchesGroup = selectedGroup === 'All' || entry.group === selectedGroup
      const matchesCategory =
        historyCategory === 'all' ||
        (historyCategory === 'live' && entry.mediaType === 'live') ||
        (historyCategory === 'movie' && entry.mediaType === 'movie') ||
        (historyCategory === 'series' && entry.mediaType === 'episode')
      return matchesSearch && matchesGroup && matchesCategory
    })
  }, [deferredSearch, historyCategory, playbackHistory, selectedGroup])

  // La chaîne lue ne change plus en fonction de la frappe : elle reste stable tant qu'aucun
  // canal n'est choisi, sinon chaque caractère saisi relançait le lecteur et figeait l'app.
  const activeChannel = useMemo(() => {
    if (viewingEpisodes) {
      return viewingEpisodes.episodes.find((channel) => channel.id === selectedChannelId) ??
        viewingEpisodes.episodes[0] ??
        EMPTY_CHANNEL
    }
    return getChannelIndex(channels).get(selectedChannelId) ??
      visibleChannels[0] ??
      EMPTY_CHANNEL
  }, [channels, selectedChannelId, viewingEpisodes, visibleChannels])

  // Émission diffusée en ce moment sur la chaîne active (Guide TV / EPG).
  const activeChannelEpg = useMemo(
    () => getEpgForChannel(
      epgData,
      activeChannel.id,
      (activeChannel as Channel).tvgId,
      (activeChannel as Channel).epgId,
    ),
    [epgData, activeChannel],
  )
  const activeChannelEpgNow = epgNow
  const currentEpgProgram = useMemo(
    () => activeChannelEpg.find((program) => program.start <= activeChannelEpgNow && program.stop >= activeChannelEpgNow) ?? null,
    [activeChannelEpg, activeChannelEpgNow],
  )
  const nextEpgProgram = useMemo(
    () => activeChannelEpg.find((program) => program.start > activeChannelEpgNow) ?? null,
    [activeChannelEpg, activeChannelEpgNow],
  )

  // Au démarrage : la dernière chaîne lue s'affiche directement en plein écran.
  const didStartFullscreenRef = useRef(false)
  useEffect(() => {
    if (!isNativeApp || authStatus !== 'signedIn') return
    if (didStartFullscreenRef.current || !activeChannel.stream) return
    didStartFullscreenRef.current = true
    setIsTheaterMode(true)
  }, [activeChannel.stream, authStatus, isNativeApp])

  // Préparation des libellés de recherche pendant les temps morts : la première saisie ne paie
  // plus la construction des libellés des 300 000 chaînes.
  useEffect(() => {
    if (channels.length === 0) return
    let cursor = 0
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
      cancelIdleCallback?: (handle: number) => void
    }
    const step = () => {
      const end = Math.min(channels.length, cursor + 20000)
      for (; cursor < end; cursor += 1) getChannelLabel(channels[cursor])
    }
    if (!idleWindow.requestIdleCallback) return
    let handle = 0
    const run = (deadline?: IdleDeadline) => {
      do {
        step()
      } while (cursor < channels.length && (deadline?.timeRemaining?.() ?? 0) > 4)
      if (cursor < channels.length) handle = idleWindow.requestIdleCallback!(run, { timeout: 2000 })
    }
    handle = idleWindow.requestIdleCallback(run, { timeout: 2000 })
    return () => idleWindow.cancelIdleCallback?.(handle)
  }, [channels])

  const visibleRowCount = Math.ceil((window.innerHeight || 800) / CHANNEL_ROW_HEIGHT) + CHANNEL_OVERSCAN * 2
  const firstVisibleChannel = Math.max(
    0,
    Math.floor(channelScrollTop / CHANNEL_ROW_HEIGHT) - CHANNEL_OVERSCAN,
  )
  const visibleChannelRows = filteredChannels.slice(
    firstVisibleChannel,
    firstVisibleChannel + visibleRowCount,
  )

  const resetChannelListScroll = useCallback(() => {
    if (channelListRef.current) {
      channelListRef.current.scrollTop = 0
    }
    setChannelScrollTop(0)
  }, [])

  const handleFavorite = (channelId: string) => {
    const updated = favorites.includes(channelId)
      ? favorites.filter((id) => id !== channelId)
      : [...favorites, channelId]
    setFavorites(updated)
    if (user && activePlaylistId) {
      localStorage.setItem(getFavoritesKey(user.id, activePlaylistId), JSON.stringify(updated))
    }

    setChannels((previous) =>
      previous.map((channel) =>
        channel.id === channelId
          ? { ...channel, isFavorite: updated.includes(channelId) }
          : channel,
      ),
    )
    setViewingEpisodes((previous) => previous
      ? {
          ...previous,
          episodes: previous.episodes.map((channel) =>
            channel.id === channelId ? { ...channel, isFavorite: updated.includes(channelId) } : channel,
          ),
        }
      : previous,
    )
  }

  // Charge les épisodes d'une série Xtream (depuis sa fiche d'information).
  const loadSeriesEpisodes = async (channel: Channel) => {
    if (!activePlaylistId || !channel.seriesId) {
      setNotice('Cette série ne contient pas les informations Xtream nécessaires aux épisodes.')
      return
    }

    setNotice('')
    setViewingEpisodes(null)
    setSelectedChannelId(channel.id)
    setPlayOnSelectChannelId('')
    const requestId = ++seriesRequestId.current
    setIsLoadingEpisodes(true)
    try {
      const response = await apiFetch(
        apiUrl(`/api/playlists/${encodeURIComponent(activePlaylistId)}/series/${encodeURIComponent(channel.seriesId)}/episodes`),
        { method: 'POST' },
      )
      const result = (await response.json()) as { episodes?: Channel[]; error?: string }
      if (!response.ok || !result.episodes) {
        throw new Error(result.error ?? 'Impossible de charger les épisodes de cette série.')
      }
      if (result.episodes.length === 0) {
        throw new Error('Aucun épisode disponible pour cette série.')
      }
      if (requestId !== seriesRequestId.current) return
      const bookmark = playbackStateKey ? readPlaybackState(playbackStateKey) : null
      const savedEpisode =
        bookmark?.seriesId === channel.seriesId && bookmark.mediaType === 'episode'
          ? result.episodes.find((episode) => episode.id === bookmark.channelId)
          : undefined
      const initialEpisode = savedEpisode ?? result.episodes[0]
      setViewingEpisodes({
        seriesId: channel.seriesId,
        seriesName: channel.name,
        episodes: result.episodes,
      })
      setSelectedVod(null)
      setPlaybackStopped(false)
      setSelectedGroup('All')
      setSelectedChannelId(initialEpisode?.id ?? channel.id)
      setPlayOnSelectChannelId(initialEpisode?.id ?? '')
      if (initialEpisode && playbackStateKey) {
        updatePlaybackState(playbackStateKey, (state) => ({
          ...state,
          channelId: initialEpisode.id,
          mediaType: 'episode',
          seriesId: channel.seriesId,
          seriesName: channel.name,
        }))
      }
    } catch (error) {
      if (requestId === seriesRequestId.current) {
        setNotice(error instanceof Error ? error.message : 'Échec du chargement des épisodes.')
      }
    } finally {
      if (requestId === seriesRequestId.current) setIsLoadingEpisodes(false)
    }
  }

  // Clic sur un film / une série : on ouvre d'abord sa fiche d'information
  // (affiche, description, bouton Lire) au lieu de lancer la lecture aussitôt.
  const openVodInfo = (channel: Channel) => {
    setNotice('')
    setSelectedVod(channel)
    vodInfoRequestId.current += 1
    setIsLoadingVodInfo(false)

    // Films et séries Xtream : on récupère le résumé, la durée, la date, les acteurs et le réalisateur.
    const mediaType = getChannelMediaType(channel)
    if ((mediaType !== 'movie' && mediaType !== 'series') || !activePlaylistId) return
    // Les séries importées depuis un fichier M3U n'ont pas d'identifiant Xtream : pas d'appel réseau.
    if (mediaType === 'series' && !channel.seriesId) return
    if (
      channel.details?.cast ||
      channel.details?.director ||
      (channel.epg.trim() && channel.epg.trim() !== 'Film' && channel.epg.trim() !== 'Série')
    ) {
      return
    }

    const resource = mediaType === 'series'
      ? `series/${encodeURIComponent(channel.seriesId ?? channel.id.replace(/^series-/, ''))}`
      : `movies/${encodeURIComponent(channel.id)}`

    const requestId = vodInfoRequestId.current
    setIsLoadingVodInfo(true)
    void apiFetch(
      apiUrl(`/api/playlists/${encodeURIComponent(activePlaylistId)}/${resource}/info`),
      { method: 'POST' },
    )
      .then(async (response) => {
        const result = (await response.json()) as {
          plot?: string
          details?: Channel['details']
          error?: string
        }
        if (!response.ok) throw new Error(result.error ?? 'Informations indisponibles pour cet élément.')
        if (requestId !== vodInfoRequestId.current) return
        setSelectedVod((current) => current && current.id === channel.id
          ? {
              ...current,
              ...(result.plot ? { epg: result.plot } : {}),
              ...(result.details ? { details: { ...current.details, ...result.details } } : {}),
            }
          : current)
      })
      .catch(() => {
        // Le fournisseur ne fournit pas d'informations supplémentaires : la fiche reste telle quelle.
      })
      .finally(() => {
        if (requestId === vodInfoRequestId.current) setIsLoadingVodInfo(false)
      })
  }

  // Lecture d'un film depuis sa fiche d'information.
  const playVodFromInfo = (channel: Channel) => {
    setSelectedVod(null)
    setPlaybackStopped(false)
    seriesRequestId.current += 1
    setIsLoadingEpisodes(false)
    setViewingEpisodes(null)
    setSelectedChannelId(channel.id)
    setPlayOnSelectChannelId(channel.id)
    if (playbackStateKey) {
      updatePlaybackState(playbackStateKey, (state) => ({
        ...state,
        channelId: channel.id,
        mediaType: 'movie',
      }))
    }
  }

  const handleChannelSelect = async (channel: Channel) => {
    setNotice('')
    const channelKind = channel.mediaType ?? getChannelMediaType(channel)
    // Re-sélectionner la chaîne déjà en lecture ne relance pas le flux : pas de coupure.
    if (channelKind === 'live' && channel.id === selectedChannelId && !viewingEpisodes) {
      return
    }
    if (channelKind === 'series' || channelKind === 'movie') {
      openVodInfo(channel)
      return
    }

    if (channel.mediaType === 'episode' && viewingEpisodes) {
      seriesRequestId.current += 1
      setIsLoadingEpisodes(false)
      setPlaybackStopped(false)
      setSelectedChannelId(channel.id)
      setPlayOnSelectChannelId(channel.id)
      if (playbackStateKey) {
        updatePlaybackState(playbackStateKey, (state) => ({
          ...state,
          channelId: channel.id,
          mediaType: 'episode',
          seriesId: viewingEpisodes.seriesId,
          seriesName: viewingEpisodes.seriesName,
        }))
      }
      return
    }

    seriesRequestId.current += 1
    setIsLoadingEpisodes(false)
    setViewingEpisodes(null)
    setPlaybackStopped(false)
    setSelectedChannelId(channel.id)
    setPlayOnSelectChannelId('')
    if (playbackStateKey) {
      updatePlaybackState(playbackStateKey, (state) => ({
        ...state,
        channelId: channel.id,
        mediaType: 'live',
      }))
    }
  }

  const handleChannelListSelect = (channel: Channel) => {
    if (activeNav !== 'Multi-écran') {
      void handleChannelSelect(channel)
      return
    }

    if (getChannelMediaType(channel) !== 'live') return
    setMultiScreenChannelIds((previous) => {
      const updated = [...previous]
      updated[selectedMultiScreenIndex] = channel.id
      return updated
    })
    const nextEmptyIndex = multiScreenChannelIds.findIndex(
      (id, index) => index !== selectedMultiScreenIndex && !id && index < multiScreenCount,
    )
    if (nextEmptyIndex >= 0) setSelectedMultiScreenIndex(nextEmptyIndex)
  }

  // Simple appui : on lance la chaîne. Double appui (souris ou OK télécommande) : plein écran TV.
  const activateChannelCard = (channel: Channel) => {
    const now = Date.now()
    const previous = channelPressRef.current
    const isDoublePress = previous.id === channel.id && now - previous.time < 500
    channelPressRef.current = isDoublePress ? { id: '', time: 0 } : { id: channel.id, time: now }
    handleChannelListSelect(channel)
    if (isDoublePress && activeNav !== 'Multi-écran' && getChannelMediaType(channel) === 'live') {
      setIsTheaterMode(true)
    }
  }

  const handlePlaybackProgress = (channel: Channel, position: number) => {
    if (!playbackStateKey) return
    const series =
      channel.mediaType === 'episode' && viewingEpisodes
        ? { id: viewingEpisodes.seriesId, name: viewingEpisodes.seriesName }
        : undefined
    let updatedHistory: PlaybackHistoryEntry[] = []
    updatePlaybackState(playbackStateKey, (state) => {
      const positions = { ...state.positions }
      if (position > 0 && getChannelMediaType(channel) !== 'live') positions[channel.id] = position
      else delete positions[channel.id]
      updatedHistory = addHistoryEntry(
        state.history,
        toHistoryEntry(channel, series, position),
      )
      return { ...state, positions, history: updatedHistory }
    })
    setPlaybackHistory(updatedHistory)
  }

  const handlePlaybackStart = (channel: Channel) => {
    if (!playbackStateKey) return
    const series =
      channel.mediaType === 'episode' && viewingEpisodes
        ? { id: viewingEpisodes.seriesId, name: viewingEpisodes.seriesName }
        : undefined
    let updatedHistory: PlaybackHistoryEntry[] = []
    updatePlaybackState(playbackStateKey, (state) => {
      updatedHistory = addHistoryEntry(
        state.history,
        toHistoryEntry(channel, series, state.positions[channel.id] ?? 0),
      )
      return { ...state, history: updatedHistory }
    })
    setPlaybackHistory(updatedHistory)
  }

  const handleHistorySelect = async (entry: PlaybackHistoryEntry) => {
    setNotice('')
    setPlayOnSelectChannelId('')
    setPlaybackStopped(false)
    if (entry.mediaType !== 'episode') {
      const channel = channels.find((item) => item.id === entry.channelId)
      if (!channel) {
        setNotice('Ce contenu n’est plus disponible dans la playlist actuelle.')
        return
      }
      setActiveNav(entry.mediaType === 'movie' ? 'Films' : 'TV en direct')
      await handleChannelSelect(channel)
      return
    }

    if (!activePlaylistId || !entry.seriesId) {
      setNotice('Cette série ne peut pas être restaurée depuis la playlist actuelle.')
      return
    }
    setIsLoadingEpisodes(true)
    const requestId = ++seriesRequestId.current
    try {
      const response = await apiFetch(
        apiUrl(`/api/playlists/${encodeURIComponent(activePlaylistId)}/series/${encodeURIComponent(entry.seriesId)}/episodes`),
        { method: 'POST' },
      )
      const result = (await response.json()) as { episodes?: Channel[]; error?: string }
      if (!response.ok || !result.episodes) {
        throw new Error(result.error ?? 'Impossible de charger cet épisode depuis l’historique.')
      }
      if (requestId !== seriesRequestId.current) return
      const episode = result.episodes.find((item) => item.id === entry.channelId)
      if (!episode) throw new Error('Cet épisode n’est plus disponible.')
      setViewingEpisodes({
        seriesId: entry.seriesId,
        seriesName: entry.seriesName ?? entry.name,
        episodes: result.episodes,
      })
      setActiveNav('Séries')
      setSelectedGroup('All')
      setSelectedChannelId(episode.id)
      setPlayOnSelectChannelId(episode.id)
      if (playbackStateKey) {
        updatePlaybackState(playbackStateKey, (state) => ({
          ...state,
          channelId: episode.id,
          mediaType: 'episode',
          seriesId: entry.seriesId,
          seriesName: entry.seriesName ?? entry.name,
        }))
      }
    } catch (error) {
      if (requestId === seriesRequestId.current) {
        setNotice(error instanceof Error ? error.message : 'Impossible de restaurer cet épisode.')
      }
    } finally {
      if (requestId === seriesRequestId.current) setIsLoadingEpisodes(false)
    }
  }

  const handleHistoryRemove = (entry: PlaybackHistoryEntry) => {
    if (!playbackStateKey) return
    let updatedHistory: PlaybackHistoryEntry[] = []
    updatePlaybackState(playbackStateKey, (state) => {
      updatedHistory = state.history.filter((item) => item.channelId !== entry.channelId)
      const positions = { ...state.positions }
      delete positions[entry.channelId]
      return { ...state, positions, history: updatedHistory }
    })
    setPlaybackHistory(updatedHistory)
  }

  const handleM3uImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      setIsImportingFile(true)
      setNotice('Lecture du fichier M3U en cours…')
      const content = await readFileAsText(file)
      const importedChannels = parseM3u(content)
      if (importedChannels.length === 0) {
        setNotice('Aucune chaîne valide trouvée dans ce fichier M3U.')
        return
      }

      const response = await apiFetch(apiUrl('/api/playlists'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name.replace(/\.(m3u8?|txt)$/i, ''),
          channels: importedChannels,
        }),
      })
      const result = (await response.json()) as { playlist?: Playlist; error?: string }
      if (!response.ok || !result.playlist) {
        throw new Error(result.error ?? 'Impossible d’enregistrer cette playlist.')
      }

      const savedPlaylist = result.playlist
      setPlaylists((previous) => [savedPlaylist, ...previous])
      setActivePlaylistId(savedPlaylist.id)
      setChannels(savedPlaylist.channels)
      setFavorites(user ? readFavorites(getFavoritesKey(user.id, savedPlaylist.id)) : [])
      setSelectedGroup('All')
      setSelectedChannelId(
        savedPlaylist.channels.find((channel) => getChannelMediaType(channel) === 'live')?.id ??
        savedPlaylist.channels[0].id,
      )
      setPlaybackHistory([])
      setPlayOnSelectChannelId('')
      setActiveNav('TV en direct')
      const savedBuckets = getMediaTypeBuckets(savedPlaylist.channels)
      setNotice(
        `${savedBuckets.live.length} chaîne(s), ${savedBuckets.movie.length} film(s) et ${savedBuckets.series.length} série(s) importés dans « ${savedPlaylist.name} ».`,
      )
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Échec de la lecture ou de l’importation du fichier.')
    } finally {
      setIsImportingFile(false)
      event.target.value = ''
    }
  }

  const handleRemoteImport = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice('')
    setIsImportingRemote(true)

    const body =
      importMode === 'url'
        ? { url: m3uUrl, name: m3uName }
        : {
          server: xtreamServer,
          username: xtreamUsername,
          password: xtreamPassword,
          name: xtreamName,
        }

    try {
      const response = await apiFetch(apiUrl(importMode === 'url' ? '/api/playlists/import-url' : '/api/playlists/import-xtream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = (await response.json()) as { playlist?: Playlist; error?: string }
      if (!response.ok || !result.playlist) {
        throw new Error(result.error ?? 'Impossible d’importer cette playlist.')
      }

      const importedPlaylist = result.playlist
      setPlaylists((previous) => [importedPlaylist, ...previous])
      setActivePlaylistId(importedPlaylist.id)
      setChannels(importedPlaylist.channels)
      setFavorites(user ? readFavorites(getFavoritesKey(user.id, importedPlaylist.id)) : [])
      setSelectedGroup('All')
      setSelectedChannelId(
        importedPlaylist.channels.find((channel) => getChannelMediaType(channel) === 'live')?.id ??
        importedPlaylist.channels[0].id,
      )
      setPlaybackHistory([])
      setPlayOnSelectChannelId('')
      setActiveNav('TV en direct')
      setViewingEpisodes(null)
      const importedBuckets = getMediaTypeBuckets(importedPlaylist.channels)
      const importedMovies = importedBuckets.movie.length
      const importedSeries = importedBuckets.series.length
      const importedLive = importedBuckets.live.length
      setNotice(
        `${importedLive} chaîne(s) en direct, ${importedMovies} film(s) et ${importedSeries} série(s) importés dans « ${importedPlaylist.name} ».`,
      )
      setM3uUrl('')
      setXtreamPassword('')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Échec de l’importation.')
    } finally {
      setIsImportingRemote(false)
    }
  }

  const runSpeedTest = async () => {
    setIsTestingSpeed(true)
    setSpeedTestError('')
    setSpeedTestResult(null)

    try {
      const endpoint = 'https://speed.cloudflare.com'
      const latencySamples: number[] = []
      for (let index = 0; index < 3; index += 1) {
        const startedAt = performance.now()
        const response = await fetch(`${endpoint}/__down?bytes=0&cacheBust=${Date.now()}-${index}`, {
          cache: 'no-store',
        })
        if (!response.ok) throw new Error(`Le test de latence a échoué (HTTP ${response.status}).`)
        await response.arrayBuffer()
        latencySamples.push(performance.now() - startedAt)
      }

      const downloadBytes = 10_000_000
      const downloadStartedAt = performance.now()
      const downloadResponse = await fetch(`${endpoint}/__down?bytes=${downloadBytes}&cacheBust=${Date.now()}`, {
        cache: 'no-store',
      })
      if (!downloadResponse.ok) throw new Error(`Le test de téléchargement a échoué (HTTP ${downloadResponse.status}).`)
      await downloadResponse.arrayBuffer()
      const downloadSeconds = (performance.now() - downloadStartedAt) / 1000
      const download = (downloadBytes * 8) / downloadSeconds / 1_000_000

      const uploadBytes = 1_000_000
      const uploadPayload = new Blob([new Uint8Array(uploadBytes)], { type: 'application/octet-stream' })
      const uploadStartedAt = performance.now()
      const uploadResponse = await fetch(`${endpoint}/__up`, {
        method: 'POST',
        body: uploadPayload,
        cache: 'no-store',
      })
      if (!uploadResponse.ok) throw new Error(`Le test d’envoi a échoué (HTTP ${uploadResponse.status}).`)
      await uploadResponse.arrayBuffer()
      const uploadSeconds = (performance.now() - uploadStartedAt) / 1000
      const upload = (uploadBytes * 8) / uploadSeconds / 1_000_000

      setSpeedTestResult({
        latency: latencySamples.reduce((sum, sample) => sum + sample, 0) / latencySamples.length,
        download,
        upload,
      })
    } catch (error) {
      setSpeedTestError(
        error instanceof Error
          ? `${error.message} Vérifiez votre connexion puis réessayez.`
          : 'Impossible de mesurer le débit. Vérifiez votre connexion puis réessayez.',
      )
    } finally {
      setIsTestingSpeed(false)
    }
  }

  const handlePlaylistSelect = (playlist: Playlist) => {
    if (playlist.suspended) return
    seriesRequestId.current += 1
    setIsLoadingEpisodes(false)
    setActivePlaylistId(playlist.id)
    setPlaybackStopped(false)
    setChannels(playlist.channels)
    setFavorites(user ? readFavorites(getFavoritesKey(user.id, playlist.id)) : [])
    setSelectedGroup('All')
    setSelectedMovieCategory('All')
    setActiveNav('TV en direct')
    setSelectedChannelId(
      playlist.channels.find((channel) => getChannelMediaType(channel) === 'live')?.id ??
      playlist.channels[0]?.id ??
      EMPTY_CHANNEL.id,
    )
    setPlaybackHistory(readPlaybackState(getPlaybackStateKey(user?.id ?? '', playlist.id))?.history ?? [])
    setPlayOnSelectChannelId('')
    setViewingEpisodes(null)
    setNotice('')
  }

  const handlePlaylistSuspension = async (playlist: Playlist) => {
    const suspended = !playlist.suspended
    setUpdatingPlaylistStatusId(playlist.id)
    try {
      const response = await apiFetch(
        apiUrl(`/api/playlists/${encodeURIComponent(playlist.id)}/status`),
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ suspended }),
        },
      )
      const result = (await response.json()) as { playlist?: Playlist; error?: string }
      if (!response.ok || !result.playlist) {
        throw new Error(result.error ?? 'Impossible de modifier l’état de cette playlist.')
      }

      const updated = result.playlist
      const nextPlaylists = playlists.map((item) => item.id === updated.id ? updated : item)
      setPlaylists(nextPlaylists)
      if (suspended && activePlaylistId === updated.id) {
        const nextPlaylist = nextPlaylists.find((item) => !item.suspended)
        if (nextPlaylist) {
          handlePlaylistSelect(nextPlaylist)
        } else {
          if (user) localStorage.removeItem(getActivePlaylistKey(user.id))
          setActivePlaylistId('')
          setChannels([])
          setSelectedChannelId('')
          setSelectedGroup('All')
          setPlayOnSelectChannelId('')
          setPlaybackHistory([])
          setViewingEpisodes(null)
          setShowPlaylistManager(true)
        }
      } else if (!suspended && !activePlaylistId) {
        handlePlaylistSelect(updated)
      }
      setNotice(suspended
        ? `Playlist « ${updated.name} » suspendue.`
        : `Playlist « ${updated.name} » réactivée.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Impossible de modifier l’état de cette playlist.')
    } finally {
      setUpdatingPlaylistStatusId('')
    }
  }

  const handlePlaylistDelete = async (playlist: Playlist) => {
    try {
      const response = await apiFetch(apiUrl(`/api/playlists/${encodeURIComponent(playlist.id)}`), {
        method: 'DELETE',
      })
      const result = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(result.error ?? 'Impossible de supprimer cette playlist.')
      }

      const remaining = playlists.filter((item) => item.id !== playlist.id)
      const nextPlaylist = remaining.find((item) => !item.suspended)
      setPlaylists(remaining)
      if (activePlaylistId === playlist.id) {
        if (!nextPlaylist && user) localStorage.removeItem(getActivePlaylistKey(user.id))
        seriesRequestId.current += 1
        setIsLoadingEpisodes(false)
        setActivePlaylistId(nextPlaylist?.id ?? '')
        setChannels(nextPlaylist?.channels ?? [])
        setFavorites(
          nextPlaylist && user
            ? readFavorites(getFavoritesKey(user.id, nextPlaylist.id))
            : [],
        )
        setSelectedChannelId(
          nextPlaylist?.channels.find((channel) => getChannelMediaType(channel) === 'live')?.id ??
          nextPlaylist?.channels[0]?.id ??
          '',
        )
        setPlaybackHistory(
          nextPlaylist && user
            ? readPlaybackState(getPlaybackStateKey(user.id, nextPlaylist.id))?.history ?? []
            : [],
        )
        setSelectedGroup('All')
        setViewingEpisodes(null)
        if (!nextPlaylist && remaining.length > 0) setShowPlaylistManager(true)
      }
      setNotice(`Playlist « ${playlist.name} » supprimée.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Impossible de supprimer cette playlist.')
    }
  }

  const handlePlaylistEdit = async (playlist: Playlist) => {
    setNotice('')
    setEditSourceDetails(null)
    setEditingPlaylist(null)
    try {
      const response = await apiFetch(
        apiUrl(`/api/playlists/${encodeURIComponent(playlist.id)}/source-details`),
      )
      const details = (await response.json()) as PlaylistSourceDetails & { error?: string }
      if (!response.ok) {
        throw new Error(details.error ?? 'Impossible de lire les paramètres de cette playlist.')
      }
      setEditingPlaylist(playlist)
      setEditPlaylistName(playlist.name)
      setEditPlaylistUrl(details.sourceType === 'xtream' ? details.server : details.url)
      setEditXtreamUsername(details.username)
      setEditXtreamPassword(details.password)
      setEditSourceDetails(details)
      setIsEditPasswordVisible(true)
      setEditPlaylistChannels(null)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Impossible de lire les paramètres de cette playlist.')
    }
  }

  const handlePlaylistUpdate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editingPlaylist) return
    setIsUpdatingPlaylist(true)
    setNotice('')

    try {
      const body: {
        name: string
        url?: string
        server?: string
        username?: string
        password?: string
        channels?: Channel[]
      } = { name: editPlaylistName.trim() }

      if (editPlaylistChannels) {
        body.channels = editPlaylistChannels
      } else if (editSourceDetails?.sourceType === 'xtream' && (
        editPlaylistUrl.trim() !== editSourceDetails.server ||
        editXtreamUsername.trim() !== editSourceDetails.username ||
        editXtreamPassword !== editSourceDetails.password
      )) {
        body.server = editPlaylistUrl.trim()
        body.username = editXtreamUsername.trim()
        body.password = editXtreamPassword
      } else if (
        editSourceDetails?.sourceType === 'm3u' &&
        editPlaylistUrl.trim() !== editSourceDetails.url &&
        editPlaylistUrl.trim()
      ) {
        body.url = editPlaylistUrl.trim()
      }
      const sourceWasUpdated = Boolean(body.channels || body.url || body.server)

      const response = await apiFetch(apiUrl(`/api/playlists/${encodeURIComponent(editingPlaylist.id)}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = (await response.json()) as { playlist?: Playlist; error?: string }
      if (!response.ok || !result.playlist) {
        throw new Error(result.error ?? 'Impossible de mettre à jour cette playlist.')
      }

      const updated = result.playlist
      setPlaylists((previous) => previous.map((item) => item.id === updated.id ? updated : item))
      if (activePlaylistId === updated.id) {
        setChannels(updated.channels)
        const startupChannel =
          updated.channels.find((channel) => getChannelMediaType(channel) === 'live') ??
          updated.channels[0]
        if (sourceWasUpdated) {
          setSelectedChannelId(startupChannel?.id ?? '')
          setPlayOnSelectChannelId(
            startupChannel && getChannelMediaType(startupChannel) === 'live'
              ? startupChannel.id
              : '',
          )
          if (user) setStartupPlaybackChannel(user.id, updated.id, updated.channels)
        }
        setSelectedGroup('All')
        setViewingEpisodes(null)
      }
      setEditingPlaylist(null)
      setEditPlaylistChannels(null)
      setEditSourceDetails(null)
      setNotice(`Playlist « ${updated.name} » mise à jour.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Impossible de mettre à jour cette playlist.')
    } finally {
      setIsUpdatingPlaylist(false)
    }
  }

  const handlePlaylistRefresh = async (playlist: Playlist) => {
    setRefreshingPlaylistId(playlist.id)
    setNotice('')
    try {
      const response = await apiFetch(
        apiUrl(`/api/playlists/${encodeURIComponent(playlist.id)}/refresh-xtream`),
        { method: 'POST' },
      )
      const result = (await response.json()) as { playlist?: Playlist; error?: string }
      if (!response.ok || !result.playlist) {
        throw new Error(result.error ?? 'Impossible d’actualiser cette playlist.')
      }

      const updated = result.playlist
      setPlaylists((previous) => previous.map((item) => item.id === updated.id ? updated : item))
      if (activePlaylistId === updated.id) {
        setChannels(updated.channels)
        setSelectedGroup('All')
        setViewingEpisodes(null)
        const startupChannel =
          updated.channels.find((channel) => getChannelMediaType(channel) === 'live') ??
          updated.channels[0]
        setSelectedChannelId(startupChannel?.id ?? '')
        setPlayOnSelectChannelId(
          startupChannel && getChannelMediaType(startupChannel) === 'live'
            ? startupChannel.id
            : '',
        )
        if (user) setStartupPlaybackChannel(user.id, updated.id, updated.channels)
      }
      const counts = updated.channels.reduce(
        (totals, channel) => {
          totals[getChannelMediaType(channel)] += 1
          return totals
        },
        { live: 0, movie: 0, series: 0 },
      )
      setNotice(
        `Catalogue actualisé : ${counts.live} chaîne(s), ${counts.movie} film(s), ${counts.series} série(s).`,
      )
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Échec de l’actualisation de la playlist.')
    } finally {
      setRefreshingPlaylistId('')
    }
  }

  const savePlaylistCustomization = async (
    playlistId: string,
    action:
      | 'rename-group'
      | 'hide-group'
      | 'show-group'
      | 'favorite-group'
      | 'unfavorite-group'
      | 'rename-channel'
      | 'hide-channel'
      | 'show-channel'
      | 'favorite-channel'
      | 'unfavorite-channel',
    details: { group?: string; name?: string; channelId?: string },
  ) => {
    const groupToHide = details.group
    const previousHiddenGroups =
      action === 'hide-group'
        ? playlists.find((item) => item.id === playlistId)?.customizations?.hiddenGroups ?? []
        : null
    if (action === 'hide-group' && groupToHide && previousHiddenGroups) {
      setPlaylists((previous) => previous.map((item) => {
        if (item.id !== playlistId) return item
        return {
          ...item,
          customizations: {
            channelNames: item.customizations?.channelNames ?? {},
            groupNames: item.customizations?.groupNames ?? {},
            hiddenGroups: [...new Set([...previousHiddenGroups, groupToHide])],
            favoriteGroups: item.customizations?.favoriteGroups ?? [],
            hiddenChannels: item.customizations?.hiddenChannels ?? [],
            favoriteChannels: item.customizations?.favoriteChannels ?? [],
          },
        }
      }))
    }

    try {
      const response = await apiFetch(
        apiUrl(`/api/playlists/${encodeURIComponent(playlistId)}/customizations`),
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ...details }),
        },
      )
      const result = (await response.json()) as { playlist?: Playlist; error?: string }
      if (!response.ok || !result.playlist) {
        throw new Error(result.error ?? 'Impossible d’enregistrer cette modification.')
      }

      const updated = result.playlist
      setPlaylists((previous) => previous.map((item) => item.id === updated.id ? updated : item))
      if (activePlaylistId === updated.id) setChannels(updated.channels)
      if (action === 'hide-channel' && details.channelId === selectedChannelId) {
        const hiddenStreams = updated.customizations?.hiddenChannels ?? []
        const hiddenGroups = updated.customizations?.hiddenGroups ?? []
        const nextChannel = updated.channels.find(
          (channel) =>
            !hiddenStreams.includes(channel.stream) &&
            !hiddenGroups.includes(channel.group),
        )
        setSelectedChannelId(nextChannel?.id ?? '')
        setPlayOnSelectChannelId(
          nextChannel && getChannelMediaType(nextChannel) === 'live' ? nextChannel.id : '',
        )
      }
      if (action === 'rename-group' && details.group === selectedGroup) {
        setSelectedGroup(details.name ?? 'All')
      } else if (action === 'hide-group' && details.group) {
        if (details.group === selectedGroup) setSelectedGroup('All')
        const selectedChannel = updated.channels.find((channel) => channel.id === selectedChannelId)
        if (selectedChannel?.group === details.group) {
          const hiddenGroups = updated.customizations?.hiddenGroups ?? []
          const hiddenChannels = updated.customizations?.hiddenChannels ?? []
          const nextChannel = updated.channels.find(
            (channel) =>
              !hiddenGroups.includes(channel.group) &&
              !hiddenChannels.includes(channel.stream),
          )
          setSelectedChannelId(nextChannel?.id ?? '')
          setPlayOnSelectChannelId(
            nextChannel && getChannelMediaType(nextChannel) === 'live' ? nextChannel.id : '',
          )
        }
      }
      setNotice('Modification enregistrée.')
    } catch (error) {
      if (previousHiddenGroups) {
        setPlaylists((previous) => previous.map((item) => item.id === playlistId
          ? {
              ...item,
              customizations: {
                channelNames: item.customizations?.channelNames ?? {},
                groupNames: item.customizations?.groupNames ?? {},
                hiddenGroups: previousHiddenGroups,
                favoriteGroups: item.customizations?.favoriteGroups ?? [],
                hiddenChannels: item.customizations?.hiddenChannels ?? [],
                favoriteChannels: item.customizations?.favoriteChannels ?? [],
              },
            }
          : item))
      }
      setNotice(error instanceof Error ? error.message : 'Impossible d’enregistrer cette modification.')
    }
  }

  const promptRenameGroup = (group: string) => {
    const name = window.prompt('Nouveau nom du groupe :', group)
    if (name === null || !activePlaylistId) return
    void savePlaylistCustomization(activePlaylistId, 'rename-group', { group, name })
  }

  const promptRenameChannel = (channel: Channel) => {
    const name = window.prompt('Nouveau nom de la chaîne :', channel.name)
    if (name === null || !activePlaylistId) return
    void savePlaylistCustomization(activePlaylistId, 'rename-channel', {
      channelId: channel.id,
      name,
    })
  }

  const handleChannelFavorite = (channel: Channel) => {
    const isLocallyFavorite = favorites.includes(channel.id)
    const isServerFavorite = favoriteChannelStreams.includes(channel.stream)
    if (isLocallyFavorite) handleFavorite(channel.id)

    if (!activePlaylistId) return
    if (isServerFavorite) {
      void savePlaylistCustomization(activePlaylistId, 'unfavorite-channel', { channelId: channel.id })
    } else if (!isLocallyFavorite) {
      void savePlaylistCustomization(activePlaylistId, 'favorite-channel', { channelId: channel.id })
    }
  }

  const isChannelFavorite = (channel: Channel) =>
    favorites.includes(channel.id) || favoriteChannelStreams.includes(channel.stream)

  const openHiddenChannelMenu = (
    event: React.MouseEvent | React.PointerEvent,
    channel: Channel,
  ) => {
    openItemContextMenu(event, { kind: 'hidden-channel', value: channel })
  }

  const saveChannelVisibility = (channel: Channel, isHidden: boolean) => {
    if (!activePlaylistId) return
    void savePlaylistCustomization(
      activePlaylistId,
      isHidden ? 'show-channel' : 'hide-channel',
      { channelId: channel.id },
    )
  }

  const hiddenChannelLabel = (channel: Channel) => (
    <>
      <strong>{channel.name}</strong>
      <span>{channel.group}</span>
    </>
  )

  const channelFavoriteLabel = (channel: Channel) => {
    return isChannelFavorite(channel) ? 'Retirer des favoris' : 'Ajouter aux favoris'
  }

  const handleChannelMenuFavorite = (channel: Channel) => {
    handleChannelFavorite(channel)
  }

  const openItemContextMenu = useCallback((
    event: React.MouseEvent | React.PointerEvent,
    item: ItemContextMenuTarget,
  ) => {
    event.preventDefault()
    if (!activePlaylistId) return
    setItemContextMenu({
      ...item,
      x: Math.max(0, Math.min(event.clientX, window.innerWidth - 210)),
      y: Math.max(0, Math.min(event.clientY, window.innerHeight - 170)),
    })
  }, [activePlaylistId])

  const startLongPressMenu = useCallback((
    event: React.PointerEvent,
    item: ItemContextMenuTarget,
  ) => {
    if (
      !activePlaylistId ||
      event.pointerType === 'mouse' ||
      (item.kind === 'channel' &&
        event.target instanceof Element &&
        event.target.closest('button'))
    ) return
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
    const x = Math.max(0, Math.min(event.clientX, window.innerWidth - 210))
    const y = Math.max(0, Math.min(event.clientY, window.innerHeight - 170))
    longPressTimer.current = setTimeout(() => {
      setItemContextMenu({ ...item, x, y })
    }, 650)
  }, [activePlaylistId])

  const cancelLongPressMenu = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  if (authStatus === 'loading') {
    return (
      <main className="auth-page">
        <div className="brand-mark">
          <img src="/iptv-premium-logo.png" alt={isNativeApp ? 'Logo Rayan TV' : 'Logo IPTV Hub'} />
        </div>
        <p className="eyebrow">{isNativeApp ? 'RAYAN TV' : 'IPTV HUB'}</p>
        <p>{isNativeApp ? 'Ouverture de Rayan TV…' : 'Ouverture d’IPTV Hub…'} {bootElapsed}s</p>
      </main>
    )
  }

  const renderChannelCard = (channel: Channel, index: number) => {
    const isFavorite = isChannelFavorite(channel)
    const isSelected = channel.id === activeChannel.id
    return (
      <div
        key={channel.id}
        role="button"
        tabIndex={0}
        className={(activeNav === 'Multi-écran'
          ? channel.id === multiScreenChannelIds[selectedMultiScreenIndex]
          : isSelected) ? 'channel-card active' : 'channel-card'}
        onContextMenu={(event) => openItemContextMenu(event, { kind: 'channel', value: channel })}
        onPointerDown={(event) => startLongPressMenu(event, { kind: 'channel', value: channel })}
        onPointerUp={cancelLongPressMenu}
        onPointerLeave={cancelLongPressMenu}
        onClick={() => activateChannelCard(channel)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            activateChannelCard(channel)
          }
        }}
      >
        <span className="channel-index">{index + 1}</span>
        <div className="channel-logo" aria-hidden="true">
          {channel.logo && channel.logo.startsWith('http') 
            ? <img src={channel.logo} alt={channel.name} /> 
            : channel.logo && !channel.logo.includes('image.png') 
              ? <span>{channel.logo}</span> 
              : <span className="channel-logo-fallback">?</span>
          }
        </div>
        <div className="channel-info">
          <strong>{channel.name}</strong>
          <span>{channel.group} · {channel.quality}</span>
        </div>
        <button
          type="button"
          className={isFavorite ? 'mini-favorite active' : 'mini-favorite'}
          aria-pressed={isFavorite}
          title={isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
          onClick={(event) => {
            event.stopPropagation()
            handleChannelFavorite(channel)
          }}
          aria-label={`${isFavorite ? 'Retirer des' : 'Ajouter aux'} favoris : ${channel.name}`}
        >
          <Star size={14} />
        </button>
      </div>
    )
  }

  const renderVodPoster = (channel: Channel) => {
    const poster = channel.logo && channel.logo.startsWith('http') ? channel.logo : ''
    return (
      <button
        key={channel.id}
        type="button"
        className="vod-poster"
        onClick={() => handleChannelListSelect(channel)}
        title={channel.name}
      >
        {poster ? (
          <img src={poster} alt={channel.name} loading="lazy" />
        ) : (
          <span className="vod-poster-fallback" aria-hidden="true">
            {channel.name.slice(0, 2).toUpperCase()}
          </span>
        )}
        <span className="vod-poster-name">{channel.name}</span>
        <span className="vod-poster-quality">
          {getChannelMediaType(channel) === 'series' ? 'Série' : 'Film'}
        </span>
      </button>
    )
  }

  return (
    <div
      className={isTheaterMode ? 'tv-app-shell player-theater' : 'tv-app-shell'}
      ref={appShellRef}
    >
      <aside className="sidebar">
        <div className="brand-box">
          <div className="brand-mark">
            <img src="/iptv-premium-logo.png" alt={isNativeApp ? 'Logo Isra' : 'Logo IPTV Hub'} />
          </div>
          <h1>Isra</h1>
          <small className="brand-version">V {APP_VERSION}</small>
        </div>

        <nav className="nav-menu" aria-label="Navigation principale">
          {sidebarItems.map(({ label, icon: Icon }) => label === 'YouTube' ? (
            <a
              key={label}
              className="nav-item youtube-nav-item"
              href="https://www.youtube.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon size={18} />
              <span>{label}</span>
            </a>
          ) : (
            <button
              key={label}
              type="button"
              data-tv-nav-item={label}
              className={label === activeNav ? 'nav-item active' : 'nav-item'}
              onClick={() => {
                if (label === 'Test vitesse') {
                  setShowSpeedTest(true)
                  void runSpeedTest()
                  return
                }
                seriesRequestId.current += 1
                setIsLoadingEpisodes(false)
                setPlayOnSelectChannelId('')
                setActiveNav(label)
                setViewingEpisodes(null)
                setSelectedVod(null)
                setVodGridCount(120)
                setSelectedMovieCategory('All')
                // Les catalogues Films / Séries ouvrent en mode affiches; le lecteur
                // réapparaît dès qu'on lance un film ou un épisode.
                setPlaybackStopped(label === 'Films' || label === 'Séries')
                setSelectedGroup('All')
                resetChannelListScroll()
                if (label === 'Playlists') setShowPlaylistManager(true)
                if (label === 'Multi-écran') {
                  setMultiScreenChannelIds((previous) =>
                    previous.length > 0
                      ? previous
                      : [liveChannels.find((channel) => channel.id === selectedChannelId)?.id ?? liveChannels[0]?.id ?? ''],
                  )
                }
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className={[
        'tv-workspace',
        activeNav === 'Multi-écran' ? 'multi-screen-layout' : '',
        isVodCatalogLayout ? 'vod-catalog-layout' : '',
        (activeNav === 'Films' || activeNav === 'Séries') && !playbackStopped && !isGlobalSearch ? 'vod-playback-layout' : '',
        activeNav === 'TV en direct' && !isVodCatalogLayout ? 'direct-layout' : '',
      ].filter(Boolean).join(' ')}>
        <header className="toolbar">
          {isNativeApp && (
            <button
              type="button"
              className="back-button"
              aria-label="Retour (appui long pour quitter l’application)"
              title="Retour — appui long pour quitter"
              onPointerDown={startBackButtonPress}
              onPointerUp={endBackButtonPress}
              onPointerLeave={cancelBackButtonPress}
              onClick={(event) => {
                if (event.detail === 0) handleBackNavigation()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  handleBackNavigation()
                }
              }}
            >
              <ArrowLeft size={20} />
            </button>
          )}
          <label className="search-box" aria-label="Rechercher dans toutes les catégories">
            <Search size={18} />
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                resetChannelListScroll()
              }}
              placeholder="Rechercher chaînes, films, séries..."
            />
          </label>
          <button
            type="button"
            className="reload-app-button"
            aria-label="Recharger l’application"
            title="Recharger l’application"
            onClick={() => window.location.reload()}
          >
            <RefreshCw size={20} />
          </button>
          <span className="current-time" aria-label="Heure actuelle">
            <Clock3 size={17} />
            <LiveClock />
          </span>
        </header>
        {notice && <p className="notice-message global-notice" role="status">{notice}</p>}

        <section className="channels-pane pane" aria-label="Chaînes">
          <header className="pane-header channels-header">
            <div className="group-picker" ref={groupPickerRef}>
              {viewingEpisodes && !isLoadingEpisodes && (
                <button
                  type="button"
                  className="episodes-back"
                  aria-label="Retour aux séries"
                  title="Retour aux séries"
                  onClick={() => {
                    setViewingEpisodes(null)
                    setSelectedChannelId(`series-${viewingEpisodes.seriesId}`)
                  }}
                >
                  <ArrowLeft size={20} />
                </button>
              )}
              <button
                type="button"
                className="group-select-button"
                aria-haspopup="listbox"
                aria-expanded={groupPickerOpen}
                aria-label="Choisir un groupe de chaînes"
                title="Choisir un groupe de chaînes"
                onClick={() => setGroupPickerOpen((open) => !open)}
              >
                <span className="group-select-label">
                  {selectedGroup === 'All'
                    ? `Tous les groupes (${groupCounts.get('All') ?? 0})`
                    : `${selectedGroup} (${groupCounts.get(selectedGroup) ?? 0})`}
                </span>
                <span className="group-select-caret" aria-hidden="true">
                  {groupPickerOpen ? '▴' : '▾'}
                </span>
              </button>
              {selectedGroup !== 'All' && (
                <button
                  type="button"
                  className="group-manage-button"
                  aria-label={`Gérer le groupe ${selectedGroup}`}
                  title="Renommer / masquer / favori"
                  onClick={(event) => openItemContextMenu(event, { kind: 'group', value: selectedGroup })}
                >
                  ⋯
                </button>
              )}
              {groupPickerOpen && (
                <div className="group-options" role="listbox" aria-label="Groupes de chaînes">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selectedGroup === 'All'}
                    className={selectedGroup === 'All' ? 'group-option selected' : 'group-option'}
                    onClick={() => {
                      setSelectedGroup('All')
                      resetChannelListScroll()
                      setGroupPickerOpen(false)
                    }}
                  >
                    Tous les groupes ({groupCounts.get('All') ?? 0})
                  </button>
                  {groups.map((group) => (
                    <button
                      key={group}
                      type="button"
                      role="option"
                      aria-selected={selectedGroup === group}
                      className={selectedGroup === group ? 'group-option selected' : 'group-option'}
                      onClick={() => {
                        setSelectedGroup(group)
                        resetChannelListScroll()
                        setGroupPickerOpen(false)
                      }}
                    >
                      {group} ({groupCounts.get(group) ?? 0})
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span>
              {isLoadingEpisodes
                ? 'Chargement des épisodes…'
                  : activeNav === 'Historique'
                    ? 'Historique de lecture'
                    : null}
              {viewingEpisodes && !isLoadingEpisodes
                ? ` ${viewingEpisodes.seriesName} · ${filteredChannels.length} épisode(s)`
                : activeNav !== 'Historique' && !isLoadingEpisodes
                  ? isGlobalSearch
                    ? `${globalSearchResultCount} résultat(s) · toutes catégories`
                    : `${filteredChannels.length} ${
                        activeNav === 'Films' ? 'film(s)' : activeNav === 'Séries' ? 'série(s)' : 'chaîne(s)'
                      }${activeNav === 'Films' || activeNav === 'Séries'
                        ? selectedGroup === 'All' ? '' : ` · ${selectedGroup}`
                        : ` · ${selectedGroup === 'All' ? activeChannel.group : selectedGroup}`}`
                  : null}
            </span>
{activeNav === 'Historique' && (
              <div className="history-category-tabs" role="group" aria-label="Catégories de l'historique">
                {([
                  ['all', 'Tout'],
                  ['live', 'Chaînes'],
                  ['movie', 'Films'],
                  ['series', 'Séries'],
                ] as const).map(([category, label]) => (
                  <button
                    key={category}
                    type="button"
                    className={historyCategory === category ? 'active' : ''}
                    aria-pressed={historyCategory === category}
                    onClick={() => {
                      setHistoryCategory(category)
                      resetChannelListScroll()
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
             )}
           </header>
          {activePlaylistId && hiddenChannelItems.length > 0 && (
            <div className="hidden-groups compact">
              <strong>Chaînes masquées</strong>
              {hiddenChannelItems.map((channel) => (
                <div className="hidden-group-row" key={channel.stream}>
                  <button
                    type="button"
                    className="hidden-group-select hidden-channel-select"
                    aria-label={`Actions pour la chaîne masquée ${channel.name}`}
                    onClick={(event) => openHiddenChannelMenu(event, channel)}
                    onContextMenu={(event) => openHiddenChannelMenu(event, channel)}
                    onPointerDown={(event) => startLongPressMenu(event, { kind: 'hidden-channel', value: channel })}
                    onPointerUp={cancelLongPressMenu}
                    onPointerLeave={cancelLongPressMenu}
                  >
                    {hiddenChannelLabel(channel)}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div
            className="channel-list"
            ref={channelListRef}
            onScroll={(event) => {
              const nextScrollTop = event.currentTarget.scrollTop
              setChannelScrollTop((currentScrollTop) =>
                Math.floor(currentScrollTop / CHANNEL_ROW_HEIGHT) ===
                Math.floor(nextScrollTop / CHANNEL_ROW_HEIGHT)
                  ? currentScrollTop
                  : nextScrollTop,
              )
            }}
          >
            <div
              className="channel-list-spacer"
              style={{ height: isGlobalSearch || isVodGrid ? 0 : firstVisibleChannel * CHANNEL_ROW_HEIGHT }}
              aria-hidden="true"
            />
            {activeNav === 'Historique'
              ? filteredHistory.map((entry, index) => (
                  <div
                    key={entry.channelId}
                    role="button"
                    tabIndex={0}
                    className="channel-card history-card"
                    onClick={() => void handleHistorySelect(entry)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        void handleHistorySelect(entry)
                      }
                    }}
                  >
                    <span className="channel-index">{index + 1}</span>
                    <div className="channel-logo" aria-hidden="true">
                      {entry.logo && entry.logo.startsWith('http') 
                        ? <img src={entry.logo} alt={entry.name} /> 
                        : entry.logo && !entry.logo.includes('image.png') 
                          ? <span>{entry.logo}</span> 
                          : <span className="channel-logo-fallback">?</span>
                      }
                    </div>
                    <div className="channel-info">
                      <strong>{entry.name}</strong>
                      <span>
                        {entry.mediaType === 'episode'
                          ? `${entry.seriesName ?? 'Série'} · ${entry.group}`
                          : `${entry.group} · ${entry.mediaType === 'movie' ? 'Film' : 'Chaîne'}`}
                        {entry.mediaType !== 'live' && entry.position >= 1
                          ? ` · ${formatPlaybackTime(entry.position)}`
                          : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="history-remove-button"
                      aria-label={`Effacer de l’historique : ${entry.name}`}
                      title="Effacer de l’historique"
                      onClick={(event) => {
                        event.stopPropagation()
                        handleHistoryRemove(entry)
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))
              : isGlobalSearch
                ? searchResultGroups.map((group) => (
                    <section className="search-result-category" key={group.type} aria-label={group.label}>
                      <h3>{group.label} <span>({group.total})</span></h3>
                      {group.total > group.channels.length && (
                        <p>Affichage des {group.channels.length} premiers résultats. Affinez votre recherche pour en trouver un autre.</p>
                      )}
                      {group.channels.map(renderChannelCard)}
                    </section>
                  ))
                : isVodGrid ? (
                    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}>
                      {activeNav === 'Films' && movieCategories.length > 1 && (
                        <div className="movie-category-select">
                          <label htmlFor="movie-category-select">Catégorie</label>
                          <select
                            id="movie-category-select"
                            value={selectedMovieCategory}
                            onChange={(event) => {
                              setSelectedMovieCategory(event.target.value)
                              resetChannelListScroll()
                            }}
                          >
                            {movieCategories.map((category) => (
                              <option key={category} value={category}>
                                {category === 'All' ? 'Toutes les catégories' : category}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div className="vod-grid-wrap" style={{ flex: 1, overflowY: 'auto' }}>
                        <div className="vod-grid">
                        {filteredChannels.slice(0, vodGridCount).map(renderVodPoster)}
                      </div>
                      {filteredChannels.length > vodGridCount && (
                        <button
                          type="button"
                          className="primary-button vod-more-button"
                          onClick={() => setVodGridCount((count) => count + 120)}
                        >
                          Afficher plus ({filteredChannels.length - vodGridCount} restants)
                        </button>
                      )}
                    </div>
                  </div>
                )
                : visibleChannelRows.map((channel, offset) =>
                    renderChannelCard(channel, firstVisibleChannel + offset),
                  )}
            <div
              className="channel-list-spacer"
              style={{
                height: isGlobalSearch || isVodGrid ? 0 : Math.max(
                  0,
                  (filteredChannels.length - firstVisibleChannel - visibleChannelRows.length) * CHANNEL_ROW_HEIGHT,
                ),
              }}
              aria-hidden="true"
            />
            {(activeNav === 'Historique' ? filteredHistory.length === 0 : filteredChannels.length === 0) && (
              <div className="empty-list">
                {activeNav === 'Historique' ? (
                  'Aucun contenu regardé pour le moment.'
                ) : activeNav === 'Multi-écran' ? (
                  'Aucune chaîne en direct dans ce groupe.'
                ) : activeNav === 'Enregistrements' ? (
                  'Cette fonction sera disponible dans une prochaine étape.'
                ) : activeNav === 'Films' || activeNav === 'Séries' ? (
                  <>
                    <p>
                      {activeNav === 'Films' ? 'Aucun film disponible.' : 'Aucune série disponible.'}
                      {' '}La playlist sélectionnée ne contient pas ce catalogue. Réimportez les identifiants Xtream de votre fournisseur pour le charger.
                    </p>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => {
                        setImportMode('xtream')
                        setShowPlaylistManager(true)
                      }}
                    >
                      Importer / actualiser Xtream
                    </button>
                  </>
                ) : (
                  'Aucune chaîne dans ce groupe.'
                )}
              </div>
            )}
          </div>
        </section>

        {/* EPG Guide TV Grid */}
        <section className="epg-pane pane" aria-label="Guide TV" style={{ display: activeNav === 'Guide TV' ? 'block' : 'none' }}>
          <EPGGrid
            channels={channels}
            epgData={epgData}
            epgOffset={epgOffset}
            onOffsetChange={setEpgOffset}
            onChannelClick={(channel) => {
              setSelectedChannelId(channel.id)
              setPlayOnSelectChannelId(channel.id)
              setActiveNav('TV en direct')
            }}
            epgLoading={epgLoading}
            epgError={epgError}
          />
        </section>

        <section className="multi-screen-pane pane" aria-label="Multi-écran" style={{ display: activeNav === 'Multi-écran' ? 'flex' : 'none' }}>
          <header className="multi-screen-header">
            <p className="eyebrow">LECTURE SIMULTANÉE</p>
            <div className="multi-screen-count" role="group" aria-label="Nombre de lecteurs">
              {[1, 2, 3, 4].map((count) => (
                <button
                  key={count}
                  type="button"
                  className={multiScreenCount === count ? 'selected' : ''}
                  aria-pressed={multiScreenCount === count}
                  onClick={() => {
                    setMultiScreenCount(count)
                    setSelectedMultiScreenIndex((current) => Math.min(current, count - 1))
                    setMultiScreenChannelIds((previous) => {
                      const liveIds = liveChannels.map((channel) => channel.id)
                      const availableIds = previous.filter((id) => id && liveIds.includes(id))
                      return Array.from({ length: count }, (_, index) => availableIds[index] ?? liveIds[index] ?? '')
                    })
                  }}
                >
                  {count}
                </button>
              ))}
            </div>
          </header>
          <div className={`multi-screen-grid multi-screen-grid-${multiScreenCount}`}>
            {Array.from({ length: multiScreenCount }, (_, index) => {
              const selectedId = multiScreenChannelIds[index] ?? ''
              const channel = liveChannels.find((item) => item.id === selectedId)
              return (
                <article
                  className={selectedMultiScreenIndex === index ? 'multi-screen-card multi-screen-card-selected' : 'multi-screen-card'}
                  key={`multi-screen-${index}`}
                >
                  <div className="multi-screen-card-header">
                    <button
                      type="button"
                      className="multi-screen-target"
                      aria-pressed={selectedMultiScreenIndex === index}
                      onClick={() => setSelectedMultiScreenIndex(index)}
                    >
                      Écran {index + 1}{selectedMultiScreenIndex === index ? ' · sélectionné' : ''}
                    </button>
                    <label className="multi-screen-channel-select">
                      <select
                        value={selectedId}
                        aria-label={`Chaîne de l’écran ${index + 1}`}
                        onChange={(event) => {
                          const updated = [...multiScreenChannelIds]
                          updated[index] = event.target.value
                          setMultiScreenChannelIds(updated)
                        }}
                      >
                        <option value="">Choisir une chaîne</option>
                        {liveChannels.map((liveChannel) => (
                          <option
                            key={liveChannel.id}
                            value={liveChannel.id}
                            disabled={multiScreenChannelIds.some((id, otherIndex) => id === liveChannel.id && otherIndex !== index)}
                          >
                            {liveChannel.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="multi-screen-audio"
                      aria-pressed={multiScreenAudioIndex === index}
                      aria-label={multiScreenAudioIndex === index ? `Couper le son de l’écran ${index + 1}` : `Activer le son de l’écran ${index + 1}`}
                      title={multiScreenAudioIndex === index ? 'Couper le son' : 'Activer le son'}
                      onClick={() => setMultiScreenAudioIndex((current) => current === index ? null : index)}
                      disabled={!channel}
                    >
                      {multiScreenAudioIndex === index ? <Volume2 size={16} /> : <VolumeX size={16} />}
                    </button>
                  </div>
                  {activeNav === 'Multi-écran' && channel ? (
                    <VideoPlayer
                      key={`${index}-${channel.id}`}
                      channel={channel}
                      compact
                      muted={multiScreenAudioIndex !== index}
                        />
                  ) : activeNav === 'Multi-écran' ? (
                    <div className="multi-screen-empty">Sélectionnez une chaîne en direct.</div>
                  ) : null}
                </article>
              )
            })}
          </div>
        </section>
        <section className="player-panel" aria-label="Lecteur" style={{ display: activeNav === 'Multi-écran' ? 'none' : undefined }}>
          {!activePlaylistId && playlists.length > 0 ? (
            <div className="no-active-playlist" role="status">
              <strong>Aucune playlist active</strong>
              <span>Réactivez une playlist dans « Mes playlists » pour reprendre la lecture.</span>
            </div>
          ) : (
            <>
              <div className="player-topbar">
                <div>
                  <h3>{activeChannel.name}</h3>
                </div>
                <span className="player-quality">{activeChannel.quality}</span>
              </div>
              {playbackStopped ? (
                <div className="player-stopped" role="status">
                  <strong>Lecture arrêtée</strong>
                  <span>Choisissez un film ou une série : sa fiche s&apos;affiche avec un bouton Lire.</span>
                </div>
              ) : (
                <VideoPlayer
                  key={activeChannel.id}
                  channel={activeChannel}
                  seriesName={viewingEpisodes?.seriesName}
                  muted={activeNav === 'Multi-écran' || isVodCatalogLayout}
                  resumePosition={
                    playbackStateKey && getChannelMediaType(activeChannel) !== 'live'
                      ? readPlaybackState(playbackStateKey)?.positions[activeChannel.id] ?? 0
                      : 0
                  }
                  autoPlay={playOnSelectChannelId === activeChannel.id}
                  onPlaybackProgress={(position) => handlePlaybackProgress(activeChannel, position)}
                  onPlaybackStart={handlePlaybackStart}
                  onToggleTheater={() => setIsTheaterMode((theater) => !theater)}
                  onTheaterModeChange={setIsTheaterMode}
                  epgProgram={currentEpgProgram}
                  nextEpgProgram={nextEpgProgram}
                />
              )}
            </>
          )}
        </section>
      </main>
      {selectedVod && (
        <div className="modal-backdrop" onClick={() => setSelectedVod(null)}>
          <section
            className="vod-detail"
            role="dialog"
            aria-modal="true"
            aria-label={selectedVod.name}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="vod-detail-poster" aria-hidden="true">
              {selectedVod.logo && selectedVod.logo.startsWith('http') ? (
                <img src={selectedVod.logo} alt="" />
              ) : (
                <span>{selectedVod.name.slice(0, 2).toUpperCase()}</span>
              )}
            </div>
            <div className="vod-detail-info">
              <p className="eyebrow">
                {getChannelMediaType(selectedVod) === 'movie' ? 'FILM' : 'SÉRIE'}
              </p>
              <h3>{selectedVod.name}</h3>
              <p className="vod-detail-meta">
                {[selectedVod.group, selectedVod.quality].filter(Boolean).join(' · ')}
              </p>
              {isLoadingVodInfo && (
                <p className="vod-detail-loading" role="status">Chargement des informations…</p>
              )}
              {selectedVod.epg.trim() &&
              !['film', 'série', 'episode de série', 'imported playlist channel']
                .includes(selectedVod.epg.trim().toLocaleLowerCase()) ? (
                <div className="vod-detail-synopsis">
                  <strong>Synopsis</strong>
                  <p className="vod-detail-desc">{selectedVod.epg}</p>
                </div>
              ) : !isLoadingVodInfo && getChannelMediaType(selectedVod) === 'movie' ? (
                <p className="vod-detail-empty">Résumé non fourni par le fournisseur.</p>
              ) : null}
              {getVodInformation(selectedVod).length > 0 && (
                <dl className="vod-detail-facts">
                  {getVodInformation(selectedVod).map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="vod-detail-actions">
                {getChannelMediaType(selectedVod) === 'movie' || !selectedVod.seriesId ? (
                  <button type="button" className="primary-button" onClick={() => playVodFromInfo(selectedVod)}>
                    <Play size={16} /> Lire
                  </button>
                ) : (
                  <button type="button" className="primary-button" onClick={() => void loadSeriesEpisodes(selectedVod)}>
                    Voir les épisodes
                  </button>
                )}
                <button
                  type="button"
                  className={isChannelFavorite(selectedVod) ? 'mini-favorite active' : 'mini-favorite'}
                  onClick={() => handleChannelFavorite(selectedVod)}
                  aria-label="Ajouter aux favoris"
                  title="Ajouter aux favoris"
                >
                  <Star size={16} />
                </button>
                <button type="button" className="ghost-button" onClick={() => setSelectedVod(null)}>
                  Fermer
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
      {showPlaylistManager && (
        <div className="modal-backdrop" onClick={() => setShowPlaylistManager(false)}>
          <section
            className="m3u-panel playlist-manager"
            role="dialog"
            aria-modal="true"
            aria-labelledby="playlist-manager-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="manager-header">
              <div>
                <p className="eyebrow">BIBLIOTHÈQUE</p>
                <h3 id="playlist-manager-title">Mes playlists</h3>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Fermer"
                onClick={() => setShowPlaylistManager(false)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="import-mode-tabs" role="tablist" aria-label="Méthode d’import">
              <button
                type="button"
                role="tab"
                aria-selected={importMode === 'file'}
                className={importMode === 'file' ? 'import-mode active' : 'import-mode'}
                onClick={() => setImportMode('file')}
              >
                Fichier
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={importMode === 'url'}
                className={importMode === 'url' ? 'import-mode active' : 'import-mode'}
                onClick={() => setImportMode('url')}
              >
                Lien M3U
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={importMode === 'xtream'}
                className={importMode === 'xtream' ? 'import-mode active' : 'import-mode'}
                onClick={() => setImportMode('xtream')}
              >
                Xtream
              </button>
            </div>
            {importMode === 'file' ? (
              <>
                <button
                  type="button"
                  className="upload-zone"
                  disabled={isImportingFile}
                  onClick={() => importFileInputRef.current?.click()}
                >
                  <span>
                    {isImportingFile
                      ? `Lecture du fichier M3U… ${importElapsed}s`
                      : 'Importer un fichier M3U/M3U8'}
                  </span>
                </button>
                <input
                  ref={importFileInputRef}
                  type="file"
                  accept={isNativeApp ? '*/*' : '.m3u,.m3u8,.txt'}
                  onChange={handleM3uImport}
                  style={{ display: 'none' }}
                />
              </>
            ) : (
              <form className="remote-import-form" onSubmit={handleRemoteImport}>
                {importMode === 'url' ? (
                  <>
                  <label className="import-field">
                    <span><Link size={15} /> URL de la playlist</span>
                    <input
                      type="url"
                      required
                      placeholder="https://exemple.com/playlist.m3u"
                      value={m3uUrl}
                      onChange={(event) => setM3uUrl(event.target.value)}
                    />
                  </label>
                  <label className="import-field">
                    <span>Nom de la playlist</span>
                    <input
                      type="text"
                      required
                      maxLength={120}
                      value={m3uName}
                      onChange={(event) => setM3uName(event.target.value)}
                    />
                  </label>
                  </>
                ) : (
                  <>
                    <label className="import-field">
                      <span><Server size={15} /> URL du serveur</span>
                      <input
                        type="url"
                        required
                        placeholder="https://serveur.exemple:8080"
                        value={xtreamServer}
                        onChange={(event) => setXtreamServer(event.target.value)}
                      />
                    </label>
                    <label className="import-field">
                      <span><User size={15} /> Identifiant</span>
                      <input
                        type="text"
                        required
                        autoComplete="username"
                        maxLength={200}
                        value={xtreamUsername}
                        onChange={(event) => setXtreamUsername(event.target.value)}
                      />
                    </label>
                    <div className="edit-password-control">
                      <label className="import-field">
                        <span><KeyRound size={15} /> Mot de passe</span>
                        <input
                          type={isImportPasswordVisible ? 'text' : 'password'}
                          required
                          autoComplete="new-password"
                          maxLength={200}
                          value={xtreamPassword}
                          onChange={(event) => setXtreamPassword(event.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        className="password-visibility-button"
                        aria-label={isImportPasswordVisible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                        title={isImportPasswordVisible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                        onClick={() => setIsImportPasswordVisible((visible) => !visible)}
                      >
                        {isImportPasswordVisible ? <EyeOff size={17} /> : <Eye size={17} />}
                      </button>
                    </div>
                    <label className="import-field">
                      <span>Nom de la playlist</span>
                      <input
                        type="text"
                        required
                        maxLength={120}
                        value={xtreamName}
                        onChange={(event) => setXtreamName(event.target.value)}
                      />
                    </label>
                  </>
                )}
                <button className="primary-button remote-import-button" type="submit" disabled={isImportingRemote}>
                  {isImportingRemote
                    ? `Importation… ${importElapsed}s`
                    : importMode === 'url'
                      ? 'Lire et importer la playlist'
                      : 'Charger Xtream Codes'}
                </button>
                <p className="help-text">
                  N’utilisez que les liens et identifiants fournis par un service que vous êtes autorisé à consulter.
                </p>
              </form>
            )}
            {editingPlaylist && (
              <form className="remote-import-form playlist-edit-form" onSubmit={handlePlaylistUpdate}>
                <h4>Modifier « {editingPlaylist.name} »</h4>
                <label className="import-field">
                  <span>Nom de la playlist</span>
                  <input
                    type="text"
                    required
                    maxLength={120}
                    value={editPlaylistName}
                    onChange={(event) => setEditPlaylistName(event.target.value)}
                  />
                </label>
                {editSourceDetails?.sourceType === 'm3u' && (
                  <label className="import-field">
                    <span><Link size={15} /> URL de la playlist M3U</span>
                    <input
                      type="url"
                      value={editPlaylistUrl}
                      onChange={(event) => setEditPlaylistUrl(event.target.value)}
                    />
                  </label>
                )}
                {editSourceDetails?.sourceType === 'xtream' && (
                  <>
                    <label className="import-field">
                      <span><Link size={15} /> URL du serveur Xtream</span>
                      <input
                        type="url"
                        required
                        value={editPlaylistUrl}
                        onChange={(event) => setEditPlaylistUrl(event.target.value)}
                      />
                    </label>
                    <label className="import-field">
                      <span><User size={15} /> Nom d’utilisateur Xtream</span>
                      <input
                        type="text"
                        required
                        maxLength={200}
                        autoComplete="username"
                        value={editXtreamUsername}
                        onChange={(event) => setEditXtreamUsername(event.target.value)}
                      />
                    </label>
                    <div className="edit-password-control">
                      <label className="import-field">
                        <span><KeyRound size={15} /> Mot de passe Xtream</span>
                        <input
                          type={isEditPasswordVisible ? 'text' : 'password'}
                          required
                          maxLength={200}
                          autoComplete="current-password"
                          value={editXtreamPassword}
                          onFocus={(event) => {
                            if (isNativeApp) event.currentTarget.select()
                          }}
                          onChange={(event) => setEditXtreamPassword(event.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        className="password-visibility-button"
                        aria-label={isEditPasswordVisible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                        title={isEditPasswordVisible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                        onClick={() => setIsEditPasswordVisible((visible) => !visible)}
                      >
                        {isEditPasswordVisible ? <EyeOff size={17} /> : <Eye size={17} />}
                      </button>
                    </div>
                  </>
                )}
                {editSourceDetails?.sourceType === 'file' && (
                  <p className="help-text">Playlist importée depuis un fichier : choisissez un nouveau fichier pour la remplacer.</p>
                )}
                {editingPlaylist.sourceType === 'file' && (
                  <>
                    <button
                      type="button"
                      className="upload-zone"
                      onClick={() => editFileInputRef.current?.click()}
                    >
                      <span>{editPlaylistChannels ? `${editPlaylistChannels.length} éléments prêts à importer` : 'Remplacer par un fichier M3U/M3U8'}</span>
                    </button>
                    <input
                      ref={editFileInputRef}
                      type="file"
                      accept={isNativeApp ? '*/*' : '.m3u,.m3u8,.txt'}
                      onChange={async (event) => {
                        const file = event.target.files?.[0]
                        if (!file) return
                        try {
                          const replacementChannels = parseM3u(await readFileAsText(file))
                          if (replacementChannels.length === 0) {
                            throw new Error('Aucune chaîne valide trouvée dans ce fichier M3U.')
                          }
                          setEditPlaylistChannels(replacementChannels)
                          setNotice(`${replacementChannels.length} éléments prêts à remplacer la playlist.`)
                        } catch (error) {
                          setNotice(error instanceof Error ? error.message : 'Impossible de lire ce fichier M3U.')
                        } finally {
                          event.target.value = ''
                        }
                      }}
                      style={{ display: 'none' }}
                    />
                  </>
                )}
                <div className="playlist-edit-actions">
                  <button className="primary-button remote-import-button" type="submit" disabled={isUpdatingPlaylist}>
                    {isUpdatingPlaylist ? 'Mise à jour…' : 'Enregistrer les modifications'}
                  </button>
                  <button
                    className="playlist-cancel-edit"
                    type="button"
                    onClick={() => {
                      setEditingPlaylist(null)
                      setEditPlaylistChannels(null)
                      setEditSourceDetails(null)
                    }}
                  >
                    Annuler
                  </button>
                </div>
              </form>
            )}
            {playlists.length > 0 ? (
              <div className="playlist-list">
                {playlists.map((playlist) => (
                  <div
                    key={playlist.id}
                    className={[
                      'playlist-item',
                      activePlaylistId === playlist.id ? 'active' : '',
                      playlist.suspended ? 'suspended' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <button
                      type="button"
                      className="playlist-select"
                      disabled={playlist.suspended}
                      onClick={() => {
                        handlePlaylistSelect(playlist)
                        setShowPlaylistManager(false)
                      }}
                    >
                      <strong>{playlist.name}</strong>
                      <span>
                        {playlist.suspended ? 'Suspendue · ' : ''}
                        {playlist.channels.length} éléments ·{' '}
                        {getMediaTypeBuckets(playlist.channels).movie.length} films ·{' '}
                        {getMediaTypeBuckets(playlist.channels).series.length} séries
                      </span>
                    </button>
                    <button
                      type="button"
                      className="playlist-refresh"
                      aria-label={`Modifier ${playlist.name}`}
                      title="Modifier la playlist"
                      onClick={() => handlePlaylistEdit(playlist)}
                    >
                      <Pencil size={16} />
                    </button>
                    {playlist.sourceType !== 'file' && (
                      <button
                        type="button"
                        className="playlist-refresh"
                        aria-label={`Actualiser la playlist ${playlist.name}`}
                        title="Actualiser la playlist"
                        disabled={refreshingPlaylistId === playlist.id}
                        onClick={() => void handlePlaylistRefresh(playlist)}
                      >
                        <RefreshCw size={16} className={refreshingPlaylistId === playlist.id ? 'spinning' : ''} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="playlist-suspend"
                      aria-label={`${playlist.suspended ? 'Réactiver' : 'Suspendre'} ${playlist.name}`}
                      title={playlist.suspended ? 'Réactiver la playlist' : 'Suspendre la playlist'}
                      disabled={updatingPlaylistStatusId === playlist.id}
                      onClick={() => void handlePlaylistSuspension(playlist)}
                    >
                      {playlist.suspended ? <Play size={16} /> : <Pause size={16} />}
                    </button>
                    <button
                      type="button"
                      className="playlist-delete"
                      aria-label={`Supprimer ${playlist.name}`}
                      onClick={() => void handlePlaylistDelete(playlist)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="help-text">Importez une playlist pour la conserver sur cet appareil.</p>
            )}
          </section>
        </div>
      )}
      {showSpeedTest && (
        <div className="modal-backdrop" onClick={() => setShowSpeedTest(false)}>
          <section
            className="speed-test-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="speed-test-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="manager-header">
              <div>
                <p className="eyebrow">CONNEXION INTERNET</p>
                <h3 id="speed-test-title">Test de vitesse</h3>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Fermer le test de vitesse"
                onClick={() => setShowSpeedTest(false)}
              >
                <X size={18} />
              </button>
            </header>
            <p className="help-text">Mesure via Cloudflare. Le test utilise environ 11 Mo de données.</p>
            {isTestingSpeed ? (
              <p className="speed-test-status" role="status">
                Test en cours : latence, téléchargement et envoi…
              </p>
            ) : speedTestError ? (
              <p className="error-message" role="alert">{speedTestError}</p>
            ) : speedTestResult ? (
              <div className="speed-test-results" role="status">
                <div><strong>{speedTestResult.latency.toFixed(0)} ms</strong><span>Latence</span></div>
                <div><strong>{speedTestResult.download.toFixed(1)} Mb/s</strong><span>Téléchargement</span></div>
                <div><strong>{speedTestResult.upload.toFixed(1)} Mb/s</strong><span>Envoi</span></div>
              </div>
            ) : null}
            <button
              type="button"
              className="primary-button remote-import-button"
              disabled={isTestingSpeed}
              onClick={() => void runSpeedTest()}
            >
              {isTestingSpeed ? 'Test en cours…' : 'Tester à nouveau'}
            </button>
          </section>
        </div>
      )}
      {itemContextMenu && (
        <div
          className="item-menu-backdrop"
          onClick={() => setItemContextMenu(null)}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            className="item-context-menu"
            role="menu"
            aria-label="Actions sur l’élément"
            style={{ left: itemContextMenu.x, top: itemContextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            {itemContextMenu.kind === 'channel' || itemContextMenu.kind === 'hidden-channel' ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const channel = itemContextMenu.value
                    setItemContextMenu(null)
                    promptRenameChannel(channel)
                  }}
                >
                  Renommer la chaîne
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const channel = itemContextMenu.value
                    const isHidden = itemContextMenu.kind === 'hidden-channel'
                    setItemContextMenu(null)
                    saveChannelVisibility(channel, isHidden)
                  }}
                >
                  {itemContextMenu.kind === 'hidden-channel' ? 'Réafficher la chaîne' : 'Masquer la chaîne'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const channel = itemContextMenu.value
                    setItemContextMenu(null)
                    handleChannelMenuFavorite(channel)
                  }}
                >
                  {channelFavoriteLabel(itemContextMenu.value)}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const group = itemContextMenu.value
                    setItemContextMenu(null)
                    promptRenameGroup(group)
                  }}
                >
                  Renommer le groupe
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const group = itemContextMenu.value
                    setItemContextMenu(null)
                    void savePlaylistCustomization(activePlaylistId, 'hide-group', { group })
                  }}
                >
                  Masquer le groupe
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const group = itemContextMenu.value
                    const action = favoriteGroupNames.includes(group)
                      ? 'unfavorite-group'
                      : 'favorite-group'
                    setItemContextMenu(null)
                    void savePlaylistCustomization(activePlaylistId, action, { group })
                  }}
                >
                  {favoriteGroupNames.includes(itemContextMenu.value)
                    ? 'Retirer des favoris'
                    : 'Ajouter aux favoris'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default App
