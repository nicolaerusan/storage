/**
 * Copyright (c) 2022 Plasmo Corp. <foss@plasmo.com> (https://www.plasmo.com) and contributors
 * Licensed under the MIT license.
 * This module share storage between chrome storage and local storage.
 */
export type StorageWatchEventListener = Parameters<
  typeof chrome.storage.onChanged.addListener
>[0]

export type StorageAreaName = Parameters<StorageWatchEventListener>[1]
export type StorageWatchCallback = (
  change: chrome.storage.StorageChange,
  area: StorageAreaName
) => void

export type StorageCallbackMap = Record<string, StorageWatchCallback>

const hasWindow = typeof window !== "undefined"

/**
 * https://docs.plasmo.com/framework-api/storage
 */
export class Storage {
  #secretSet: Set<string>

  #client: chrome.storage.StorageArea = null
  #localClient = hasWindow ? window.localStorage : null
  #area: StorageAreaName = null

  // TODO: Make another map for local storage
  #chromeStorageCommsMap: Map<
    string,
    {
      callbackSet: Set<StorageWatchCallback>
      listener: StorageWatchEventListener
    }
  > = new Map()

  hasExtensionAPI = false

  constructor(
    storageArea = "sync" as StorageAreaName,
    secretKeyList: string[] = []
  ) {
    this.#secretSet = new Set(secretKeyList)
    this.#area = storageArea

    if (chrome?.storage) {
      this.#client = chrome.storage[storageArea]
      this.hasExtensionAPI = true
    }
  }

  /**
   * Sync the key/value between chrome storage and local storage.
   * @param key
   * @returns false if the value is unchanged or it is a secret key.
   */
  sync = (key: string) =>
    new Promise((resolve) => {
      if (this.#secretSet.has(key) || !this.hasExtensionAPI) {
        resolve(false)
        return
      }

      const previousValue = this.#localClient?.getItem(key)

      this.#client.get(key, (s) => {
        const value = s[key] as string
        this.#localClient?.setItem(key, value)
        resolve(value !== previousValue)
      })
    })

  /**
   * Get value from either local storage or chrome storage.
   */
  get = <T = string>(key: string) =>
    new Promise<T>((resolve) => {
      if (this.hasExtensionAPI) {
        this.#client.get(key, (s) => {
          resolve(this.#parseValue(s[key]) as T)
        })
      } else {
        // If chrome storage is not available, use localStorage
        // TODO: TRY asking for storage permission and retry?
        const value = this.#localClient?.getItem(key)
        resolve(this.#parseValue(value) as T)
      }
    })

  /**
   * Set the value. If it is a secret, it will only be set in extension storage.
   * Returns a warning if storage capacity is almost full.
   * Throws error if the new item will make storage full
   */
  set = (key: string, rawValue: any) =>
    new Promise<string | undefined>(async (resolve, reject) => {
      const value = JSON.stringify(rawValue)

      let warning: string

      // If not a secret, we set it in localstorage as well
      if (!this.#secretSet.has(key)) {
        this.#localClient?.setItem(key, value)
      }

      if (this.hasExtensionAPI) {
        if (this.#area !== "managed") {
          const client = chrome.storage[this.#area]
          const quota = client.QUOTA_BYTES || 1

          const newValueByteSize = byteLengthCharCode(value)
          const [byteInUse, oldValueByteSize] = await Promise.all([
            client.getBytesInUse(),
            client.getBytesInUse(key)
          ])

          const newByteInUse = byteInUse + newValueByteSize - oldValueByteSize

          // if used 80% of quota, show warning
          const usedPercentage = newByteInUse / quota
          if (usedPercentage > 0.8) {
            warning = `Storage quota is almost full. ${newByteInUse}/${quota}, ${
              usedPercentage * 100
            }%`
          }

          if (usedPercentage > 1.0) {
            reject(new Error(`ABORTED - New value would exceed storage quota.`))
            return
          }
        }

        this.#client.set({ [key]: value }, () => resolve(warning))
        return
      }

      resolve(undefined)
    })

  remove = (key: string) =>
    new Promise<void>((resolve) => {
      // If not a secret, we set it in localstorage as well
      if (!this.#secretSet.has(key)) {
        this.#localClient?.removeItem(key)
      }

      if (this.hasExtensionAPI) {
        this.#client.remove(key, resolve)
        return
      }

      resolve(undefined)
    })

  watch = (callbackMap: StorageCallbackMap): boolean => {
    if (!this.isWatchingSupported()) {
      return false
    }

    this.#addListener(callbackMap)

    return true
  }

  isWatchingSupported = () => this.hasExtensionAPI

  #addListener = (callbackMap: StorageCallbackMap) => {
    Object.entries(callbackMap).forEach(([key, callback]) => {
      const callbackSet =
        this.#chromeStorageCommsMap.get(key)?.callbackSet || new Set()

      callbackSet.add(callback)

      if (callbackSet.size > 1) {
        return
      }

      const chromeStorageListener: StorageWatchCallback = (
        changes,
        areaName
      ) => {
        if (areaName !== this.#area) {
          return
        }

        const callbackKeySet = new Set(Object.keys(callbackMap))
        const changeKeys = Object.keys(changes)

        const relevantKeyList = changeKeys.filter((key) =>
          callbackKeySet.has(key)
        )

        if (relevantKeyList.length === 0) {
          return
        }

        for (const key of relevantKeyList) {
          const storageComms = this.#chromeStorageCommsMap.get(key)

          storageComms?.callbackSet?.forEach((callback) => {
            callback(
              {
                newValue: this.#parseValue(changes[key].newValue),
                oldValue: this.#parseValue(changes[key].oldValue)
              },
              areaName
            )
          })
        }
      }

      chrome.storage.onChanged.addListener(chromeStorageListener)

      this.#chromeStorageCommsMap.set(key, {
        callbackSet,
        listener: chromeStorageListener
      })
    })
  }

  unwatch = (callbackMap: StorageCallbackMap): boolean => {
    if (!this.isWatchingSupported()) {
      return false
    }
    this.#removeListener(callbackMap)
    return true
  }

  #removeListener(callbackMap: StorageCallbackMap) {
    Object.entries(callbackMap)
      .filter(([key]) => this.#chromeStorageCommsMap.has(key))
      .forEach(([key, callback]) => {
        const storageComms = this.#chromeStorageCommsMap.get(key)
        storageComms.callbackSet.delete(callback)

        if (storageComms.callbackSet.size === 0) {
          this.#chromeStorageCommsMap.delete(key)
          chrome.storage.onChanged.removeListener(storageComms.listener)
        }
      })
  }

  unwatchAll = () => {
    this.#removeAllListener()
  }

  #removeAllListener() {
    this.#chromeStorageCommsMap.forEach(({ listener }) =>
      chrome.storage.onChanged.removeListener(listener)
    )

    this.#chromeStorageCommsMap.clear()
  }

  #parseValue(rawValue: any) {
    try {
      if (rawValue !== undefined) {
        return JSON.parse(rawValue)
      }
    } catch (e) {
      // ignore error. TODO: debug log them maybe
      console.error(e)
    }
    return undefined
  }
}

export * from "./hook"

// https://stackoverflow.com/a/23329386/3151192
function byteLengthCharCode(str: string) {
  // returns the byte length of an utf8 string
  let s = str.length
  for (var i = str.length - 1; i >= 0; i--) {
    const code = str.charCodeAt(i)
    if (code > 0x7f && code <= 0x7ff) s++
    else if (code > 0x7ff && code <= 0xffff) s += 2
    if (code >= 0xdc00 && code <= 0xdfff) i-- //trail surrogate
  }
  return s
}
