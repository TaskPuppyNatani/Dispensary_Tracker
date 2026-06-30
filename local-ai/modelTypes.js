"use strict";

/**
 * @typedef {"installed" | "missing" | "invalid"} ModelInstallationState
 */

/**
 * @typedef {object} ModelArtifactSummary
 * @property {number} fileCount
 * @property {number} directoryCount
 * @property {number} totalBytes
 * @property {string[]} extensions
 */

/**
 * @typedef {object} ModelValidationResult
 * @property {boolean} valid
 * @property {ModelInstallationState} status
 * @property {string} reason
 * @property {string[]} errors
 * @property {string[]} warnings
 * @property {ModelArtifactSummary} artifactSummary
 * @property {object | null} metadata
 * @property {string | null} metadataSource
 */

/**
 * @typedef {object} ModelMetadata
 * @property {string} id
 * @property {string} displayName
 * @property {string} directoryName
 * @property {string} modelPath
 * @property {ModelInstallationState} status
 * @property {string} reason
 * @property {string[]} capabilities
 * @property {object} runtimeHints
 * @property {ModelArtifactSummary} artifactSummary
 * @property {ModelValidationResult} validation
 */

/**
 * @typedef {object} ModelInstallationStatus
 * @property {string} modelId
 * @property {string} modelPath
 * @property {ModelInstallationState} status
 * @property {string} reason
 * @property {ModelValidationResult} validation
 */

module.exports = {};
