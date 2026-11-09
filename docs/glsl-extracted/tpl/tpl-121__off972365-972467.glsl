// template literal at char 972365..972467  body length 101  glsl-marker-hits 3
// context before: "cilWriteMask:0});return l.defines={Q24:\"\"},l.onBeforeCompile=h=>{h.fragmentShader=h.fragmentShader.replace(\"#include <alphamap_fragment>\",`#ifdef USE_ALPHAMAP\ndiffuseColor.a*=texture2D(alphaMap,vAlphaMapUv).r;\n#endif`).replace(\"#include <colorspace_fragment>\","
// context after : ")},l.name=s.name,l.userData=s.userData,l}function u1(s,e){if(e===VM)return console.warn(\"THREE.BufferGeometryUtils.toTrianglesDrawMode(): Geometry already defined as triangles.\"),s;if(e===Lf||e===Bv)"
// ======================================================================
gl_FragColor=vec4(mix(vec3(1.0),gl_FragColor.rgb,gl_FragColor.a),1.0);
#include <colorspace_fragment>
