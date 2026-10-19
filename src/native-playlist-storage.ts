const DATABASE_NAME = 'iptv-hub-native'
const DATABASE_VERSION = 1
const PLAYLIST_STORE = 'playlists'

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase() {
  if (databasePromise) return databasePromise

  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(PLAYLIST_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Impossible d’ouvrir la bibliothèque locale.'))
    request.onblocked = () => reject(new Error('La bibliothèque locale est occupée. Redémarrez l’application puis réessayez.'))
  }).catch((error: unknown) => {
    databasePromise = null
    throw error
  })

  databasePromise = pending
  return pending
}

export async function getNativePlaylists<T>(): Promise<T[]> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PLAYLIST_STORE, 'readonly')
    const request = transaction.objectStore(PLAYLIST_STORE).getAll()
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error ?? new Error('Impossible de charger la bibliothèque locale.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Le chargement de la bibliothèque locale a échoué.'))
  })
}

export async function getNativePlaylist<T>(id: string): Promise<T | null> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PLAYLIST_STORE, 'readonly')
    const request = transaction.objectStore(PLAYLIST_STORE).get(id)
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
    request.onerror = () => reject(request.error ?? new Error('Impossible de charger cette playlist locale.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Le chargement de cette playlist locale a échoué.'))
  })
}

export async function saveNativePlaylist<T extends { id: string }>(playlist: T): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PLAYLIST_STORE, 'readwrite')
    transaction.objectStore(PLAYLIST_STORE).put(playlist)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Impossible d’enregistrer la playlist sur cet appareil.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('L’enregistrement local de la playlist a échoué.'))
  })
}

export async function updateNativePlaylist<T extends { id: string }>(
  id: string,
  update: (playlist: T) => T,
): Promise<T | null> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PLAYLIST_STORE, 'readwrite')
    const store = transaction.objectStore(PLAYLIST_STORE)
    const request = store.get(id)
    let updatedPlaylist: T | null = null

    request.onsuccess = () => {
      if (!request.result) return
      updatedPlaylist = update(request.result as T)
      store.put(updatedPlaylist)
    }
    request.onerror = () => transaction.abort()
    transaction.oncomplete = () => resolve(updatedPlaylist)
    transaction.onerror = () => reject(transaction.error ?? new Error('Impossible de mettre à jour la playlist sur cet appareil.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('La mise à jour locale de la playlist a échoué.'))
  })
}

export async function deleteNativePlaylist(id: string): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PLAYLIST_STORE, 'readwrite')
    transaction.objectStore(PLAYLIST_STORE).delete(id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Impossible de supprimer la playlist de cet appareil.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('La suppression locale de la playlist a échoué.'))
  })
}
