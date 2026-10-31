import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'javboss:similar-include-local'
const EVENT_NAME = 'javboss:similar-include-local-change'

export function readSimilarIncludeLocal() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === null ? true : value === '1'
  } catch {
    return true
  }
}

export default function useSimilarIncludeLocal() {
  const [includeLocal, setIncludeLocal] = useState(readSimilarIncludeLocal)

  useEffect(() => {
    const handler = (event) => setIncludeLocal(Boolean(event.detail))
    window.addEventListener(EVENT_NAME, handler)
    return () => window.removeEventListener(EVENT_NAME, handler)
  }, [])

  const update = useCallback((value) => {
    const next = Boolean(value)
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
    } catch {
      // ignore storage failures
    }
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: next }))
  }, [])

  return [includeLocal, update]
}
