import AppModal from '@/shared/ui/AppModal'
import { useEffect, useState } from 'react'
import { zh } from '@/utils/i18n'

async function copyToClipboard(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Fall through to the legacy path when the Clipboard API is blocked.
  }
  try {
    const area = document.createElement('textarea')
    area.value = value
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}

export default function OnlineVerificationModal({ open, url, onClose }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  useEffect(() => {
    setCopied(false)
    setCopyFailed(false)
  }, [open, url])

  const handleCopy = async () => {
    const ok = await copyToClipboard(url)
    setCopied(ok)
    setCopyFailed(!ok)
  }

  return (
    <AppModal
      open={open}
      onClose={onClose}
      ariaLabel={zh('在线片源验证', 'Online stream verification')}
      zIndex={1500}
      contentClassName="w-[min(34rem,calc(100vw-2rem))] rounded-lg bg-white p-5 shadow-xl"
    >
      <h2 className="text-base font-semibold text-gray-900">
        {zh('需要先完成站点验证', 'Complete the site verification first')}
      </h2>
      <p className="mt-2 text-sm leading-6 text-gray-600">
        {zh(
          '在线片源站点要求浏览器验证。请打开下面的地址完成验证，然后回到 JavBoss 重新播放。',
          'The online provider requires browser verification. Open the address below, finish the check, then play again in JavBoss.'
        )}
      </p>
      <input
        readOnly
        value={url}
        aria-label={zh('验证地址', 'Verification address')}
        onFocus={(event) => event.currentTarget.select()}
        className="mt-3 w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-800 outline-none focus:border-blue-500"
      />
      <div className="mt-2 flex items-start justify-between gap-3">
        <span className="pt-1 text-xs text-gray-500">
          {copied
            ? zh('链接已复制', 'Link copied')
            : copyFailed
              ? zh('复制失败，请手动选中地址', 'Copy failed; select the address manually')
              : zh('可选中地址手动复制', 'Select the address to copy manually')}
        </span>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            onClick={handleCopy}
          >
            {zh('复制链接', 'Copy link')}
          </button>
          <button
            type="button"
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
            onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
          >
            {zh('打开验证页', 'Open verification page')}
          </button>
          <button
            type="button"
            className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
            onClick={onClose}
          >
            {zh('关闭', 'Close')}
          </button>
        </div>
      </div>
    </AppModal>
  )
}
