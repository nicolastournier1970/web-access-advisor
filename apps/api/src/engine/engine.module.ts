/**
 * Injection seam for @waa/core. Services never import the engine directly —
 * they inject the ENGINE facade, so tests can substitute fakes without
 * launching browsers (same pattern as the ENV token).
 */
import { Global, Module } from '@nestjs/common';
import {
  createLlmProvider,
  createRecorder,
  detectBrowsers,
  getStorageStateStatus,
  isAuthUrl,
  loadAuthDomainsConfig,
  loadRecordingFile,
  probeProfile,
  runAnalysis,
  sessionPaths,
  validateStorageState,
} from '@waa/core';

export const engineFacade = {
  createRecorder,
  runAnalysis,
  detectBrowsers,
  probeProfile,
  getStorageStateStatus,
  validateStorageState,
  loadRecordingFile,
  loadAuthDomainsConfig,
  isAuthUrl,
  sessionPaths,
  createLlmProvider,
};
export type EngineFacade = typeof engineFacade;

/** Injection token: `@Inject(ENGINE) private readonly engine: EngineFacade`. */
export const ENGINE = Symbol('WAA_ENGINE');

@Global()
@Module({
  providers: [{ provide: ENGINE, useValue: engineFacade }],
  exports: [ENGINE],
})
export class EngineModule {}
