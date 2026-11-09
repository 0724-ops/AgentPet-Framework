// template literal at char 330457..330574  body length 116  glsl-marker-hits 1
// context before: " ( int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i ++ ) {\n\t\t\t\tplane = clippingPlanes[ i ];\n\t\t\t\tclipped = ( dot( vClipPosition, plane.xyz ) > plane.w ) && clipped;\n\t\t\t}\n\t\t\t#pragma unroll_loop_end\n\t\t\tif ( clipped ) discard;\n\t\t#endif\n\t#endif\n#endif`,VL="
// context after : ",HL=`#if NUM_CLIPPING_PLANES > 0\n\tvarying vec3 vClipPosition;\n#endif`,GL=`#if NUM_CLIPPING_PLANES > 0\n\tvClipPosition = - mvPosition.xyz;\n#endif`,WL=`#if defined( USE_COLOR_ALPHA )\n\tdiffuseColor *= vC"
// ======================================================================
#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
	uniform vec4 clippingPlanes[ NUM_CLIPPING_PLANES ];
#endif
