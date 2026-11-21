let hooksRegistered = false

export const markHooksRegistered = (): void => {
  hooksRegistered = true
}

export const areHooksRegistered = (): boolean => hooksRegistered
