import React, { memo, useState, useEffect, useMemo, useRef } from 'react';
import { Handle, Position, NodeProps, useEdges, useReactFlow } from 'reactflow';
import { PSDNodeData, StyleAnchor } from '../types';
import { useProceduralStore } from '../store/ProceduralContext';
import { findLayerByPath } from '../services/psdService';
import { Palette, Plus, Trash2, Image as ImageIcon, Loader2 } from 'lucide-react';
import { Layer } from 'ag-psd';

interface LayerOption {
  id: string;
  name: string;
  depth: number;
}

// Flatten PSD hierarchy to a selectable list (Depth-First)
const flattenLayers = (layers: Layer[], path: string = '', depth = 0): LayerOption[] => {
    let result: LayerOption[] = [];
    layers.forEach((layer, index) => {
        const currentPath = path ? `${path}.${index}` : `${index}`;
        // Skip hidden or empty groups if desired, but for style we might want them.
        // Let's include everything that has a name.
        if (layer.name && layer.name !== '!!TEMPLATE') {
            result.push({ id: currentPath, name: layer.name, depth });
        }
        if (layer.children) {
            result = result.concat(flattenLayers(layer.children, currentPath, depth + 1));
        }
    });
    return result;
};

export const StyleAnchorNode = memo(({ id, data }: NodeProps<PSDNodeData>) => {
    const [selectedLayerId, setSelectedLayerId] = useState<string>('');
    const [isSampling, setIsSampling] = useState(false);
    const [anchors, setAnchors] = useState<StyleAnchor[]>(data.styleAnchors || []);
    
    const edges = useEdges();
    const { setNodes } = useReactFlow();
    
    // Store Connection
    const { psdRegistry, sampleStyle, registerStyleAnchors, unregisterNode } = useProceduralStore();

    // 1. Resolve Upstream PSD Source
    const sourcePsdId = useMemo(() => {
        const edge = edges.find(e => e.target === id && e.targetHandle === 'psd-in');
        return edge ? edge.source : null;
    }, [edges, id]);

    const psd = sourcePsdId ? psdRegistry[sourcePsdId] : null;

    // 2. Build Layer Options
    const layerOptions = useMemo(() => {
        if (!psd || !psd.children) return [];
        return flattenLayers(psd.children);
    }, [psd]);

    // Cleanup
    useEffect(() => {
        return () => unregisterNode(id);
    }, [id, unregisterNode]);

    // Sync to Registry & Data Persistence
    useEffect(() => {
        // Broadcast to Global Registry for consumers
        registerStyleAnchors(id, anchors);

        // Update Node Data for persistence
        setNodes(nds => nds.map(n => {
            if (n.id === id) {
                return { ...n, data: { ...n.data, styleAnchors: anchors } };
            }
            return n;
        }));
    }, [anchors, id, registerStyleAnchors, setNodes]);

    // Handle Adding an Anchor
    const handleAddAnchor = async () => {
        if (!selectedLayerId || !psd) return;

        const layerOption = layerOptions.find(l => l.id === selectedLayerId);
        if (!layerOption) return;

        // Retrieve Binary Layer
        const rawLayer = findLayerByPath(psd, selectedLayerId);
        
        // Validation: Must be a pixel layer
        if (!rawLayer || !rawLayer.canvas) {
            alert("Selected layer contains no pixel data to sample.");
            return;
        }

        setIsSampling(true);
        try {
            // A. Generate Thumbnail (64x64)
            const canvas = rawLayer.canvas as HTMLCanvasElement; // ag-psd returns canvas usually
            
            // Create optimization canvas
            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.width = 64; 
            thumbCanvas.height = 64;
            const thumbCtx = thumbCanvas.getContext('2d');
            
            if (thumbCtx) {
                // Scale / Center Crop
                const ratio = Math.max(64 / canvas.width, 64 / canvas.height);
                const w = canvas.width * ratio;
                const h = canvas.height * ratio;
                const offsetX = (64 - w) / 2;
                const offsetY = (64 - h) / 2;
                
                thumbCtx.drawImage(canvas, offsetX, offsetY, w, h);
                const thumbnailBase64 = thumbCanvas.toDataURL('image/jpeg', 0.8);

                // B. Sample Style (Palette & Vibe) using the store helper
                const { palette, vibe } = await sampleStyle(canvas);

                const newAnchor: StyleAnchor = {
                    id: Date.now().toString(),
                    layerId: selectedLayerId,
                    layerName: layerOption.name,
                    thumbnail: thumbnailBase64,
                    palette,
                    vibe
                };

                setAnchors(prev => [...prev, newAnchor]);
                setSelectedLayerId(''); // Reset selection
            }

        } catch (e) {
            console.error("Failed to anchor style:", e);
        } finally {
            setIsSampling(false);
        }
    };

    const handleRemoveAnchor = (anchorId: string) => {
        setAnchors(prev => prev.filter(a => a.id !== anchorId));
    };

    return (
        <div className="w-[320px] bg-slate-900 rounded-lg shadow-2xl border border-amber-500/50 font-sans flex flex-col overflow-hidden transition-colors hover:border-amber-400">
             
             {/* Input Handle */}
             <Handle 
                type="target" 
                position={Position.Left} 
                id="psd-in" 
                className="!w-3 !h-3 !bg-blue-500 !border-2 !border-slate-800 z-50 transition-all duration-300" 
                style={{ top: '32px' }}
                title="Input: Source PSD"
             />

             {/* Header */}
             <div className="bg-amber-950/40 p-2 border-b border-amber-500/30 flex items-center justify-between relative overflow-hidden">
                <div className="flex items-center space-x-2 z-10">
                   <Palette className="w-4 h-4 text-amber-400" />
                   <div className="flex flex-col leading-none">
                     <span className="text-sm font-bold text-amber-100 tracking-tight">The Gallery</span>
                     <span className="text-[9px] text-amber-500/70 font-mono">STYLE ANCHOR</span>
                   </div>
                </div>
                {anchors.length > 0 && (
                    <span className="text-[9px] bg-amber-900/50 text-amber-300 px-1.5 py-0.5 rounded border border-amber-500/30 font-bold z-10">
                        {anchors.length} ACTIVE
                    </span>
                )}
             </div>

             {/* Body */}
             <div className="p-3 bg-slate-950 space-y-3">
                 
                 {/* 1. Selector Section */}
                 {!psd ? (
                     <div className="text-[10px] text-slate-500 text-center italic border border-dashed border-slate-800 p-2 rounded bg-slate-900/50">
                         Connect Source PSD to extract styles...
                     </div>
                 ) : (
                     <div className="space-y-2">
                         <div className="flex gap-2">
                             <select 
                                value={selectedLayerId} 
                                onChange={(e) => setSelectedLayerId(e.target.value)}
                                className="flex-1 bg-slate-800 border border-slate-700 text-xs text-slate-200 rounded px-2 py-1.5 focus:border-amber-500 outline-none"
                             >
                                 <option value="" disabled>Select Source Layer...</option>
                                 {layerOptions.map(l => (
                                     <option key={l.id} value={l.id}>
                                         {'\u00A0'.repeat(l.depth * 2)}{l.name}
                                     </option>
                                 ))}
                             </select>
                             <button 
                                onClick={handleAddAnchor}
                                disabled={!selectedLayerId || isSampling}
                                className={`px-2 rounded border flex items-center justify-center transition-all ${
                                    selectedLayerId && !isSampling 
                                        ? 'bg-amber-600 border-amber-500 text-white hover:bg-amber-500' 
                                        : 'bg-slate-800 border-slate-700 text-slate-500 cursor-not-allowed'
                                }`}
                             >
                                 {isSampling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                             </button>
                         </div>
                     </div>
                 )}

                 {/* 2. Anchor Gallery */}
                 <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar border-t border-slate-800/50 pt-2">
                     {anchors.length === 0 && psd && (
                         <div className="text-[9px] text-slate-600 text-center py-2">
                             No style anchors pinned.
                         </div>
                     )}

                     {anchors.map(anchor => (
                         <div key={anchor.id} className="bg-slate-900 border border-slate-700 rounded p-1.5 flex items-center space-x-2 group hover:border-amber-500/30 transition-colors">
                             {/* Thumbnail */}
                             <div className="w-10 h-10 shrink-0 rounded bg-black border border-slate-800 overflow-hidden relative">
                                 <img src={anchor.thumbnail} alt="thumb" className="w-full h-full object-cover" />
                             </div>

                             {/* Metadata */}
                             <div className="flex-1 min-w-0">
                                 <div className="flex justify-between items-start">
                                     <span className="text-[10px] font-bold text-slate-200 truncate pr-1" title={anchor.layerName}>
                                         {anchor.layerName}
                                     </span>
                                     <button 
                                        onClick={() => handleRemoveAnchor(anchor.id)}
                                        className="text-slate-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                                     >
                                         <Trash2 className="w-3 h-3" />
                                     </button>
                                 </div>
                                 <div className="flex items-center space-x-2 mt-1">
                                     <span className="text-[8px] font-mono text-amber-500/80 bg-amber-950/30 px-1 rounded border border-amber-900/50">
                                         {anchor.vibe}
                                     </span>
                                 </div>
                                 {/* Palette Strip */}
                                 <div className="flex mt-1.5 h-1.5 w-full rounded-sm overflow-hidden opacity-80">
                                     {anchor.palette.map((color, i) => (
                                         <div key={i} className="flex-1 h-full" style={{ backgroundColor: color }} title={color}></div>
                                     ))}
                                 </div>
                             </div>
                         </div>
                     ))}
                 </div>

             </div>
        </div>
    );
});