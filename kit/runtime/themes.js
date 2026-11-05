'use strict';
/**
 * themes.js - colour schemes for kit-drawn screens. Picked per app in its
 * settings ("theme"); unknown ids fall back to M Tricolour, the default.
 * oil = colour of oil temperature (red in M Tricolour, so it stands apart from the blue coolant).
 * bar = fill of the OEM-style bars, hang = their peak hold (default: the fill colour), sel = selected tab (selText = its name, default sel), marker = the '|' at the end of a bar / on a chart.
 * ramp = colours a bar runs through from low to high; hotRamp = a dial's arc, running
 * from the theme colour to red at the dial's limit (redline, max boost, ...).
 */
const THEMES = {
    m_red: {
        name: 'M Red',
        bg: '#050506', panelTop: '#17181c', panelBottom: '#0d0d10', panelEdge: '#2a2b31',
        tab: '#e6e6e6', track: '#222329', tick: '#5a5c64', text: '#ffffff', dim: '#8e9199',
        accent: '#e1001a', accent2: '#ff5a5f', ok: '#e1001a', warn: '#ffb31a', crit: '#ff1f1f', cold: '#3d8bff',
        glow: '#e1001a55', stripes: ['#e1001a'], oil: '#e1001a', bar: '#d7001a', sel: '#e1001a', marker: '#ffffff', ramp: ['#7a0010', '#e1001a', '#ff5a64'],
        hotRamp: ['#7a0010', '#b00016', '#e1001a', '#ff2030', '#ff5a64'],
    },
    m_tricolour: {
        name: 'M Tricolour',
        bg: '#04060a', panelTop: '#141a24', panelBottom: '#0a0d13', panelEdge: '#242c39',
        tab: '#e6e6e6', track: '#1b212b', tick: '#4c5666', text: '#f4f7fb', dim: '#8a95a6',
        accent: '#f4f7fb', accent2: '#81c4ff', ok: '#f4f7fb', warn: '#ffb020', crit: '#ef2b2d', cold: '#7fd1ff',
        glow: '#ffffff40', stripes: ['#81c4ff', '#16588e', '#e7222e'], oil: '#ef2b2d', ramp: ['#7d8694', '#c9d0da', '#ffffff'],
        bar: '#a8101c', hang: '#ef2b2d', sel: '#ef2b2d', selText: '#ffffff', marker: '#ef2b2d',
        hotRamp: ['#1f5fd0', '#3d9bff', '#3d9bff', '#c04cdc', '#ef2b2d'],
    },
    ice: {
        name: 'Ice White',
        bg: '#050607', panelTop: '#1a1c20', panelBottom: '#0d0e10', panelEdge: '#2e3138',
        tab: '#ffffff', track: '#24262b', tick: '#62666e', text: '#ffffff', dim: '#9aa0a8',
        accent: '#e9f2ff', accent2: '#ffffff', ok: '#e9f2ff', warn: '#ffc94d', crit: '#ff4040', cold: '#8fd3ff',
        glow: '#e9f2ff40', stripes: ['#e9f2ff'], oil: '#e9f2ff', bar: '#c9d3df', sel: '#ffffff', marker: '#ffffff', ramp: ['#6d7785', '#c9d6e6', '#ffffff'],
        hotRamp: ['#6d7785', '#c9d6e6', '#e9f2ff', '#ff9a9a', '#ff4040'],
    },
    amber: {
        name: 'Night Amber',
        bg: '#060504', panelTop: '#1a1815', panelBottom: '#0d0c0a', panelEdge: '#2e2a24',
        tab: '#ffb000', track: '#25221d', tick: '#655d50', text: '#ffe2b0', dim: '#9a8a70',
        accent: '#ff9d00', accent2: '#ffc65c', ok: '#ff9d00', warn: '#ffd000', crit: '#ff3b1f', cold: '#7fb7ff',
        glow: '#ff9d0050', stripes: ['#ff9d00'], oil: '#ff9d00', bar: '#ff9d00', sel: '#ff9d00', marker: '#ffe2b0', ramp: ['#8a4b00', '#ff9d00', '#ffd27a'],
        hotRamp: ['#8a4b00', '#ff9d00', '#ff9d00', '#ff6a1f', '#ff3b1f'],
    },
    // The Grid identities (Tron: Legacy x M): Sam, Flynn, Rinzler, Ares
    sam: {
        name: 'Sam',
        bg: '#020509', panelTop: '#0a161f', panelBottom: '#050b11', panelEdge: '#14445a',
        tab: '#e3f5fc', track: '#0c1d28', tick: '#2f5c70', text: '#e3f5fc', dim: '#7695a6',
        accent: '#67e8ff', accent2: '#b8f6ff', ok: '#67e8ff', warn: '#ffb24a', crit: '#ff6a24', cold: '#67e8ff',
        glow: '#67e8ff55', stripes: ['#67e8ff'], oil: '#ffb24a', bar: '#3fc4e0', sel: '#67e8ff', selText: '#e3f5fc', marker: '#e3f5fc',
        ramp: ['#1b6e85', '#67e8ff', '#d8fbff'], hotRamp: ['#1b6e85', '#3fc4e0', '#67e8ff', '#ffb24a', '#ff6a24'],
    },
    flynn: {
        name: 'Flynn',
        bg: '#05080e', panelTop: '#151b24', panelBottom: '#0a0d13', panelEdge: '#2e3a48',
        tab: '#ffffff', track: '#1a2029', tick: '#56616f', text: '#ffffff', dim: '#90a6b3',
        accent: '#eef6ff', accent2: '#ffffff', ok: '#eef6ff', warn: '#ffd88a', crit: '#ff7a4a', cold: '#cfe6ff',
        glow: '#ffffff44', stripes: ['#eef6ff'], oil: '#ffd88a', bar: '#d8e4f0', sel: '#ffffff', selText: '#ffffff', marker: '#ffffff',
        ramp: ['#5c6a7a', '#c9d6e6', '#ffffff'], hotRamp: ['#5c6a7a', '#c9d6e6', '#eef6ff', '#ffd88a', '#ff7a4a'],
    },
    rinzler: {
        name: 'Rinzler',
        bg: '#0a0603', panelTop: '#1d140b', panelBottom: '#0f0a05', panelEdge: '#45290f',
        tab: '#ffe8d6', track: '#25190e', tick: '#6d4d30', text: '#ffe8d6', dim: '#9a8472',
        accent: '#ff8a1f', accent2: '#ffc27a', ok: '#ff8a1f', warn: '#ffd23a', crit: '#ff2e14', cold: '#7fb7ff',
        glow: '#ff8a1f55', stripes: ['#ff8a1f'], oil: '#ffd23a', bar: '#ff8a1f', sel: '#ff8a1f', selText: '#ffe8d6', marker: '#ffe8d6',
        ramp: ['#7a3a00', '#ff8a1f', '#ffc27a'], hotRamp: ['#7a3a00', '#c45e0a', '#ff8a1f', '#ff5a1a', '#ff2e14'],
    },
    ares: {
        name: 'Ares',
        bg: '#0a0305', panelTop: '#1d0b0f', panelBottom: '#100507', panelEdge: '#4a1219',
        tab: '#ffe0e2', track: '#25100f', tick: '#703a41', text: '#ffe0e2', dim: '#a3787e',
        accent: '#ff3340', accent2: '#ff8a90', ok: '#ff3340', warn: '#ffb24a', crit: '#ffffff', cold: '#7fb7ff',
        glow: '#ff334055', stripes: ['#ff3340'], oil: '#ff8a90', bar: '#e01828', sel: '#ff3340', selText: '#ffe0e2', marker: '#ffe0e2',
        ramp: ['#6e0010', '#ff3340', '#ff8a90'], hotRamp: ['#6e0010', '#b0101e', '#ff3340', '#ff6a4a', '#ffd0c0'],
    },
};

function theme(id) { return THEMES[id] || THEMES.m_tricolour; }
const ids = () => Object.keys(THEMES);

module.exports = { THEMES, theme, ids };
