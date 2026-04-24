import { LoadingManager } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { createMsftTextureDdsExtension } from './MSFTTextureDDSExtension'
import { MSFSDDSLoader, type MSFSDDSLoadOptions } from './MSFSDDSLoader'

export function createMsfsGltfLoader(
  options: {
    readonly urlResolver?: (url: string) => string
    readonly decodeNormalSources?: boolean
    readonly textureLoadOptions?: MSFSDDSLoadOptions
  } = {}
): GLTFLoader {
  const loadingManager = new LoadingManager()
  loadingManager.addHandler(
    /\.dds$/iu,
    new MSFSDDSLoader(loadingManager, options.textureLoadOptions)
  )
  if (options.urlResolver != null) {
    loadingManager.setURLModifier(url => options.urlResolver!(url))
  }

  const loader = new GLTFLoader(loadingManager)
  loader.register(parser =>
    createMsftTextureDdsExtension(parser as never, {
      decodeNormalSources: options.decodeNormalSources,
      textureLoadOptions: options.textureLoadOptions
    })
  )

  return loader
}
