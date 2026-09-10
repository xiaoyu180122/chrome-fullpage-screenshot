import os
from PIL import Image, ImageDraw

def create_icon(size):
    # Render at 4x for smooth antialiasing, then downsample
    supersample = 4
    canvas_size = size * supersample
    img = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    scale = canvas_size / 128.0

    # Draw rounded squircle background
    r = int(26 * scale)
    margin = int(4 * scale)
    bbox = [margin, margin, canvas_size - margin, canvas_size - margin]
    
    # Modern gradient/dark background
    draw.rounded_rectangle(bbox, radius=r, fill=(15, 23, 42, 255), outline=(59, 130, 246, 255), width=max(1, int(4 * scale)))

    # Draw document / web page frame
    pw = int(52 * scale)
    ph = int(74 * scale)
    px1 = int((canvas_size - pw) / 2)
    py1 = int(18 * scale)
    px2 = px1 + pw
    py2 = py1 + ph
    
    # Document rectangle
    draw.rounded_rectangle([px1, py1, px2, py2], radius=int(6 * scale), fill=(30, 41, 59, 255), outline=(96, 165, 250, 255), width=max(1, int(3 * scale)))

    # Document content lines
    line_left = px1 + int(8 * scale)
    line_right = px2 - int(8 * scale)
    
    line1_y = py1 + int(14 * scale)
    draw.line([line_left, line1_y, line_right, line1_y], fill=(148, 163, 184, 255), width=max(1, int(2.5 * scale)))
    
    line2_y = py1 + int(24 * scale)
    draw.line([line_left, line2_y, line_right - int(12 * scale), line2_y], fill=(148, 163, 184, 255), width=max(1, int(2.5 * scale)))
    
    line3_y = py1 + int(34 * scale)
    draw.line([line_left, line3_y, line_right, line3_y], fill=(148, 163, 184, 255), width=max(1, int(2.5 * scale)))

    # Center camera lens icon
    cx = int(canvas_size / 2)
    cy = py1 + int(50 * scale)
    radius = int(12 * scale)
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=(59, 130, 246, 255), outline=(255, 255, 255, 255), width=max(1, int(2.5 * scale)))
    
    inner_r = int(5 * scale)
    draw.ellipse([cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r], fill=(255, 255, 255, 255))

    # Downward expansion arrow indicator for full-page screenshot
    arrow_y = canvas_size - int(18 * scale)
    arrow_w = int(10 * scale)
    arrow_h = int(6 * scale)
    draw.polygon([
        (cx, arrow_y + arrow_h),
        (cx - arrow_w, arrow_y - arrow_h),
        (cx + arrow_w, arrow_y - arrow_h)
    ], fill=(56, 189, 248, 255))

    # High quality downsampling
    final_img = img.resize((size, size), Image.Resampling.LANCZOS)
    return final_img

def main():
    out_dir = os.path.join(os.path.dirname(__file__), 'icons')
    os.makedirs(out_dir, exist_ok=True)

    sizes = [16, 32, 48, 128]
    for s in sizes:
        img = create_icon(s)
        out_path = os.path.join(out_dir, f'icon{s}.png')
        img.save(out_path, 'PNG')
        print(f"Generated {out_path} ({s}x{s})")

if __name__ == '__main__':
    main()
