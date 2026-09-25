"""Núcleo de htdemucs sin STFT/iSTFT ni números complejos, para exportarlo a ONNX.

Es una copia fiel de `HTDemucs.forward` (demucs 4.0.1) desde la normalización hasta los decoders.
Entradas:  mix [B, 2, L]  (L = longitud de entrenamiento, ~7.8 s)
           mag [B, 4, 2048, T]  (= HTDemucs._magnitude(HTDemucs._spec(mix)), partes real/imag como canales)
Salidas:   spec [B, S, 4, 2048, T]  (espectrograma estimado por fuente, real/imag como canales)
           wave [B, S, 2, L]  (rama temporal)
La salida final es  ispec(mask(spec)) + wave,  calculado fuera en CPU.
"""

import math

import torch
from torch import nn


def core_input_shapes(model) -> tuple[tuple, tuple]:
    length = int(model.segment * model.samplerate)
    frames = int(math.ceil(length / model.hop_length))
    return (1, model.audio_channels, length), (1, model.audio_channels * 2, model.nfft // 2, frames)


class HTDemucsCore(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.m = model

    def forward(self, mix: torch.Tensor, mag: torch.Tensor):
        m = self.m
        x = mag
        B, C, Fq, T = x.shape
        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        std = x.std(dim=(1, 2, 3), keepdim=True)
        x = (x - mean) / (1e-5 + std)

        xt = mix
        meant = xt.mean(dim=(1, 2), keepdim=True)
        stdt = xt.std(dim=(1, 2), keepdim=True)
        xt = (xt - meant) / (1e-5 + stdt)

        saved, saved_t, lengths, lengths_t = [], [], [], []
        for idx, encode in enumerate(m.encoder):
            lengths.append(x.shape[-1])
            inject = None
            if idx < len(m.tencoder):
                lengths_t.append(xt.shape[-1])
                tenc = m.tencoder[idx]
                xt = tenc(xt)
                if not tenc.empty:
                    saved_t.append(xt)
                else:
                    inject = xt
            x = encode(x, inject)
            if idx == 0 and m.freq_emb is not None:
                frs = torch.arange(x.shape[-2], device=x.device)
                emb = m.freq_emb(frs).t()[None, :, :, None].expand_as(x)
                x = x + m.freq_emb_scale * emb
            saved.append(x)

        if m.crosstransformer:
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_upsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_upsampler_t(xt)
            x, xt = m.crosstransformer(x, xt)
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_downsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_downsampler_t(xt)

        for idx, decode in enumerate(m.decoder):
            skip = saved.pop(-1)
            x, pre = decode(x, skip, lengths.pop(-1))
            offset = m.depth - len(m.tdecoder)
            if idx >= offset:
                tdec = m.tdecoder[idx - offset]
                length_t = lengths_t.pop(-1)
                if tdec.empty:
                    pre = pre[:, :, 0]
                    xt, _ = tdec(pre, None, length_t)
                else:
                    skip = saved_t.pop(-1)
                    xt, _ = tdec(xt, skip, length_t)

        S = len(m.sources)
        x = x.view(B, S, -1, Fq, T)
        x = x * std[:, None] + mean[:, None]
        xt = xt.view(B, S, -1, mix.shape[-1])
        xt = xt * stdt[:, None] + meant[:, None]
        return x, xt
