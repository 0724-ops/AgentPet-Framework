// lines 3559..3565   char-offsets 453238..453480
	#include <logdepthbuf_fragment>
	gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}`,iO=`uniform float rotation;
uniform vec2 center;
