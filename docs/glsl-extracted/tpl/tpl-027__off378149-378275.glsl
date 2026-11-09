// template literal at char 378149..378275  body length 125  glsl-marker-hits 1
// context before: "e, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );\n#endif`,RD=`#if defined( USE_LOGDEPTHBUF )\n\tgl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;\n#endif`,CD="
// context after : ",PD=`#ifdef USE_LOGDEPTHBUF\n\tvarying float vFragDepth;\n\tvarying float vIsPerspective;\n#endif`,ID=`#ifdef USE_LOGDEPTHBUF\n\tvFragDepth = 1.0 + gl_Position.w;\n\tvIsPerspective = float( isPerspectiveMatri"
// ======================================================================
#if defined( USE_LOGDEPTHBUF )
	uniform float logDepthBufFC;
	varying float vFragDepth;
	varying float vIsPerspective;
#endif
